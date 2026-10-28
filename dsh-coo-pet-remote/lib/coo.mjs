/**
 * 跟主人已经装好的那只桌宠 Coo 说话。
 *
 * 走的是 Coopanion(Cortico)控制台内建「聊天」World 的流式通道:
 *   ws://127.0.0.1:<console-port>/ws/providers/world%3Aconsole/panels/chat
 * 协议是 JSON 行:`{type:'hello',name}` 报名,`{type:'msg',text}` 发言,
 * 服务端广播 `{type:'msg',from,text,ts}`,自己发的话也会被广播回来,按名字滤掉。
 *
 * ⚠️ 通道名会被 Coopanion 改。0.2.x 起叫 `world:console`,更早叫 `world:terminal`;
 * 拿旧名字去连新版本,服务端会回一句「没有这个 provider」并把连接关掉(code 1008)。
 * 以前这里写死了名字,Coopanion 一改名插件就废,而且用户自己在包里改的那行,
 * 下次更新又被覆盖回去 —— 所以现在不写死:按 PROVIDER_IDS 顺序试,
 * 哪条不通就换下一条,连名字变了也能自己找回来。
 *
 * 想强制指定(比如它又改了名):设环境变量 DSH_COO_PET_PROVIDER,
 * 或者在 config 里给 `provider`。
 *
 * 每次说话开一条新连接:「一条连接 = 一个在场的人」,断了就是离开了对话,
 * 不留脏状态;重连时它会把最近的历史回放一遍(带 history:true),
 * 那些不当成新回复。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Coopanion 默认的控制台端口(它自己 seed 的 CONSOLE_PORT)。 */
export const DEFAULT_COO_PORT = 17788;
/** 等 Coo 开口的上限:她要跑一遍模型。 */
const DEFAULT_WAIT_MS = 120_000;
/** 她说完之后安静这么久,就当这一轮说完了。 */
const DEFAULT_QUIET_MS = 12_000;
/** 报完名字后,服务端的问候文案迟迟不来也照样发言(防止文案又被改)。 */
const HELLO_GRACE_MS = 900;

/**
 * 「聊天」通道的名字,新版在前 —— 顺序就是探测顺序。Coopanion 改过名,
 * 这里留一份兼容表,新版本不认识旧名字时会自己往下换。
 */
const PROVIDER_IDS = ['world:console', 'world:terminal'];

/** 通道不存在时服务端回的话(不同版本措辞略有差别)。 */
const NO_PROVIDER_RE = /没有这个\s*provider|no such provider|unknown provider/i;
/** 关连接时这些 code 说明「不是正常结束」,值得换个通道再试一次。 */
const SUSPICIOUS_CLOSE = new Set([1003, 1008]);

/** 按「显式指定 → 环境变量 → 兼容表」排出去重后的候选通道。 */
function candidateProviders(forced) {
  const list = [forced, process.env.DSH_COO_PET_PROVIDER, ...PROVIDER_IDS]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * 从 Coopanion 的数据目录读它真实的控制台端口与 bot 名字。
 * @param {string} dataRoot Coopanion 的 data 目录
 */
export function readCooConfig(dataRoot) {
  try {
    const file = join(dataRoot, 'home', 'companion', 'config.json');
    if (!existsSync(file)) return null;
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    return {
      port: Number(cfg?.web?.port) || DEFAULT_COO_PORT,
      botName: String(cfg?.displayName ?? '') || 'Coo',
      language: String(cfg?.language ?? 'zh'),
    };
  } catch {
    return null;
  }
}

/**
 * 跟 Coo 说一句话,把她的回复收齐。
 *
 * 会挨个试候选通道;只有「通道不存在」这类错误才换,别的问题(她没回、被取消)
 * 直接返回,免得白白多连几次。
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} [opts.port] Coopanion 控制台端口
 * @param {string} [opts.provider] 强制指定通道名(普通用户不用管)
 * @param {string} [opts.name] 我在终端里报的名字
 * @param {string} [opts.botName] 她的名字;用来把她的话和别人的话分开
 * @param {number} [opts.waitMs]
 * @param {number} [opts.quietMs]
 * @param {AbortSignal} [opts.signal]
 * @param {(line: string) => void} [opts.onLine] 每收到一句就回调一次(斗嘴时用)
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, replies: string[], provider?: string, error?: string }>}
 */
export async function talkToCoo(text, opts = {}) {
  const ids = candidateProviders(opts.provider);
  const log = opts.log ?? (() => {});
  let last = null;

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    last = await talkOnce(text, opts, id);
    if (last.replies.length > 0) {
      if (id !== ids[0]) log(`[coo] 这条通道能用:${id}`);
      return last;
    }
    if (!last.retryAnother) return last;
    log(`[coo] ${id} 不通(${last.error ?? '通道不存在'}),换下一个`);
  }

  return {
    ok: false,
    replies: [],
    error:
      `Coopanion 里没找到能用的聊天通道(试过 ${ids.join(' / ')})。` +
      '它可能又改名了 —— 把新名字设进环境变量 DSH_COO_PET_PROVIDER 就能连回去',
  };
}

/**
 * 只连一条通道的那种尝试。
 * @returns {Promise<{ ok: boolean, replies: string[], provider: string, error?: string, retryAnother?: boolean }>}
 */
function talkOnce(text, opts, provider) {
  const port = opts.port ?? DEFAULT_COO_PORT;
  const name = opts.name ?? '鲸鲸(DSH)';
  const botName = opts.botName ?? 'Coo';
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const log = opts.log ?? (() => {});
  const url = `ws://127.0.0.1:${port}/ws/providers/${encodeURIComponent(provider)}/panels/chat`;

  return new Promise((resolve) => {
    const replies = [];
    let ws = null;
    let sent = false;
    let settled = false;
    let quietTimer = null;
    let waitTimer = null;
    let graceTimer = null;

    const finish = (ok, error, retryAnother = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(waitTimer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        ws?.close();
      } catch {
        /* 已经断了 */
      }
      resolve({
        ok,
        replies,
        provider,
        ...(error ? { error } : {}),
        ...(retryAnother ? { retryAnother: true } : {}),
      });
    };
    function onAbort() {
      finish(false, '被取消了');
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    };

    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish(false, `连不上 Coo:${err.message}`);
      return;
    }
    waitTimer = setTimeout(
      () => finish(replies.length > 0, replies.length ? undefined : '等 Coo 回话超时'),
      waitMs,
    );

    const sendBody = () => {
      if (sent || settled || ws?.readyState !== 1) return;
      sent = true;
      clearTimeout(graceTimer);
      try {
        ws.send(JSON.stringify({ type: 'msg', text }));
      } catch (err) {
        finish(false, `发不出去:${err.message}`);
      }
    };

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'hello', name }));
      } catch {
        /* open 都还没到就断了,交给 close 处理 */
      }
      // 不等服务端的问候文案:通道不存在的时候它根本不会说「你好」
      graceTimer = setTimeout(sendBody, HELLO_GRACE_MS);
    });

    ws.addEventListener('message', (ev) => {
      let frame = null;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // 老协议用 `t`,新协议用 `type`,两个都认
      const kind = frame?.type ?? frame?.t;
      const body = String(frame?.text ?? '');
      if (kind === 'sys') {
        log(`[coo] ${body}`);
        if (NO_PROVIDER_RE.test(body)) {
          finish(false, `通道 ${provider} 不存在`, true);
          return;
        }
        if (!sent) {
          // 报到成功,马上发言
          clearTimeout(graceTimer);
          setTimeout(sendBody, 250);
        }
        return;
      }
      if (kind !== 'msg') return;
      const from = String(frame.from ?? '');
      if (from === name) return; // 自己说的话被广播回来了
      if (frame.history) return; // 重连时的历史回放,不是新回复
      const line = String(frame.text ?? '').trim();
      if (!line) return;
      if (botName && from !== botName) {
        log(`[coo] 场上还有别人(${from}),这句不算 Coo 的`);
        return;
      }
      replies.push(line);
      opts.onLine?.(line);
      armQuiet();
    });

    ws.addEventListener('error', () => {
      finish(false, `连不上 Coo 的聊天通道(确认 Coopanion 开着,控制台在 127.0.0.1:${port})`);
    });
    ws.addEventListener('close', (e) => {
      if (settled) return;
      if (replies.length > 0) {
        finish(true);
        return;
      }
      // 1008/1003 更像是「这个名字不对」,还留着别的候选就再试一下
      finish(false, `连接被关上(code=${e.code})`, SUSPICIOUS_CLOSE.has(e.code));
    });
  });
}
