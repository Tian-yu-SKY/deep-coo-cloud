// dsh-link/bridge/lib/ws-server.mjs — 极简 RFC6455 WebSocket 服务端（无 npm 依赖）。
// 只实现 bridge 需要的部分：text 帧、ping/pong、close、分片重组；不支持扩展/压缩。
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

export class WsConnection extends EventEmitter {
  constructor(socket, { log, remoteAddress = '?' } = {}) {
    super();
    this.socket = socket;
    this.log = log;
    this.remoteAddress = remoteAddress;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    socket.on('data', (data) => this._onData(data));
    socket.on('error', (error) => {
      this.log?.warn(`ws client error (${this.remoteAddress}): ${error.message}`);
      this._markClosed();
    });
    socket.on('close', () => this._markClosed());
  }

  _markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const parsed = this._parseFrame();
      if (!parsed) return;
      const { fin, opcode, payload } = parsed;
      if (opcode === 0x8) { // close
        this._sendClose(1000, '');
        return;
      }
      if (opcode === 0x9) { // ping
        this._sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue; // pong
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this.fragmentOpcode = opcode;
          this.fragments = [];
        }
        this.fragments.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1) this.emit('message', full.toString('utf8'));
        continue;
      }
      // 未知 opcode：协议错误，关闭。
      this._sendClose(1002, 'unsupported opcode');
      return;
    }
  }

  _parseFrame() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      const big = this.buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD_BYTES)) {
        this._sendClose(1009, 'payload too large');
        return null;
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_PAYLOAD_BYTES) {
      this._sendClose(1009, 'payload too large');
      return null;
    }
    let maskKey = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + length) return null;
    let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _sendFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch (error) {
      this.log?.warn(`ws write failed: ${error.message}`);
      this._markClosed();
    }
  }

  _sendClose(code, reason) {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._sendFrame(0x8, payload);
    try { this.socket.end(); } catch { /* ignore */ }
    this._markClosed();
  }

  sendText(text) {
    this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  close(code = 1000, reason = '') {
    this._sendClose(code, reason);
  }
}

/**
 * 在 http.Server 上挂载**一组**带 token 鉴权的 WebSocket 端点。
 *
 * 关键：只能注册**一个** `upgrade` 监听器，在内部按 pathname 分发。
 * 之前给每个端点各挂一个监听器的写法有顺序敏感 bug：Node 的 upgrade 事件按注册顺序
 * 调用，第一个监听器看到「不是自己的 path」就 reject/ destroy socket，
 * 后面端点的监听器再也收不到 upgrade（实测 /chat 先注册时 /events 握手必失败）。
 *
 * @param {import('node:http').Server} httpServer
 * @param {Array<{path:string,isTokenValid:(token:string)=>boolean,onConnection:(conn,req)=>void}>} endpoints
 * @param {{log?:object}} options
 */
export function attachWebSocketEndpoints(httpServer, endpoints, { log } = {}) {
  const routes = (endpoints ?? []).map((endpoint) => ({ ...endpoint }));
  httpServer.on('upgrade', (req, socket, head) => {
    const reject = (status, message) => {
      try {
        socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    };
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return reject(400, 'Bad Request');
    }
    const route = routes.find((candidate) => candidate.path === url.pathname);
    if (!route) return reject(404, 'Not Found');
    if (typeof route.isTokenValid === 'function' && !route.isTokenValid(url.searchParams.get('token') ?? '')) {
      log?.warn(`ws ${route.path}: rejected upgrade from ${req.socket.remoteAddress} (bad token)`);
      return reject(401, 'Unauthorized');
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      return reject(400, 'Bad Request');
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    try {
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'));
    } catch {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    const conn = new WsConnection(socket, { log, remoteAddress: req.socket.remoteAddress });
    if (head && head.length > 0) conn._onData(head);
    route.onConnection(conn, req);
  });
}

/**
 * 单端点便捷包装（保留旧 API；内部仍走统一的 upgrade 分发器）。
 * 注意：同一个 httpServer 上多个端点**必须**用 attachWebSocketEndpoints 一次挂载，
 * 否则仍会出现顺序敏感的 destroy 问题。
 */
export function attachWebSocketEndpoint(httpServer, options) {
  attachWebSocketEndpoints(httpServer, [options], { log: options.log });
}
