/**
 * 心情(mood)的**纯函数**部分:给 `pet_status` 出文案、按心情挑气泡动作。
 *
 * 数据来自 bridge v1.1 的 `GET /mood`:
 *   {ok:true, mood:{label, valence, arousal, energy, memoryCount, selfNote, updatedAt}}
 * 拉取、缓存、定时刷新在 `brain-remote.mjs`;这里只做「拿到快照之后怎么显示/怎么动」。
 *
 * 为什么单独一个模块:
 * - 不动网络、不依赖 DSH,可以直接单元测试(见 `test/mood.test.mjs`);
 * - `impl.js` 用 `?v=<时间戳>` 动态 import 它(和其余本地模块一致),改了重载插件就生效。
 */

/**
 * 形象包 `web/whale/figure.json` 的 `vocab` 全集(实测 38 个词,来源:
 * `dsh-link/coo-pet-data/web/whale/figure.json`)。页面的 `body.do(word)` 只认这些词,
 * 给别的词等于不动(也可能被页面当成无效动作丢掉),所以**只用这个集合里的**。
 */
export const FIGURE_VOCAB = Object.freeze([
  'neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy', 'thinking',
  'smug', 'pout', 'worried', 'determined', 'flustered', 'scared', 'excited', 'cry', 'confused',
  'stand', 'jump', 'hop', 'look', 'turn', 'nod', 'shake', 'spin', 'sit', 'sleep', 'dizzy',
  'walk', 'run', 'wave', 'bow', 'shiver', 'flap', 'dance',
]);

/**
 * 心情映射**允许使用**的动作集合。
 *
 * 只挑「脸部表情」这一类:气泡说话时突然 `walk`/`jump`/`sit` 会显得莫名其妙,
 * 而且 `sleep` 是趴下睡觉、`dizzy` 是晕倒,不适合当说话时的默认动作。
 * 全部是 `FIGURE_VOCAB` 的子集 —— 就算映射逻辑写错,也不会往页面塞不存在的词。
 */
export const SAFE_MOOD_ACTIONS = Object.freeze([
  'neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy',
  'thinking', 'smug', 'pout', 'worried', 'excited', 'cry', 'confused',
]);

/** 没有心情数据 / 数据不可用时的默认动作(和上游 `say(..., ['happy'])` 一致)。 */
export const DEFAULT_MOOD_ACTIONS = Object.freeze(['happy']);

/**
 * 情绪标签 → 动作(中英都认:deep-soul 的自述理论上是中文,但 bridge/后端换实现时
 * 也可能给英文,bridge 协议没规定语言)。**按数组顺序**做子串匹配,所以具体词要排在
 * 泛化词前面(例:「困惑」不能在「困」之前被吃掉;这里干脆用「困倦/犯困/好困」这些不会误伤的写法)。
 */
const LABEL_RULES = Object.freeze([
  { words: ['兴奋', '激动', '雀跃', '亢奋', '有精神', '有活力', 'excited', 'thrilled'], action: 'excited' },
  { words: ['惊喜', '惊讶', '吃惊', 'surprised', 'shocked'], action: 'surprised' },
  { words: ['开心', '高兴', '愉快', '快乐', '开怀', '美滋滋', 'happy', 'joyful', 'glad'], action: 'happy' },
  { words: ['得意', '骄傲', '自豪', 'smug', 'proud'], action: 'smug' },
  { words: ['喜欢', '爱', '心动', '中意', 'love', 'adore'], action: 'love' },
  { words: ['害羞', '羞涩', '脸红', '不好意思', 'shy', 'embarrassed'], action: 'shy' },
  { words: ['困惑', '迷惑', '疑惑', 'confused', 'puzzled'], action: 'confused' },
  { words: ['好奇', '思考', '琢磨', '沉思', 'curious', 'thinking'], action: 'thinking' },
  { words: ['生气', '愤怒', '恼火', '烦躁', '不爽', 'angry', 'annoyed', 'furious'], action: 'angry' },
  { words: ['焦虑', '担心', '紧张', '不安', '害怕', '恐惧', '惊慌', 'anxious', 'worried', 'nervous', 'scared', 'afraid'], action: 'worried' },
  { words: ['难过', '伤心', '低落', '失落', '沮丧', '委屈', '悲', 'sad', 'down', 'upset'], action: 'sad' },
  { words: ['想哭', '哭了', '哭泣', 'cry', 'tearful'], action: 'cry' },
  { words: ['困倦', '犯困', '好困', '想睡', '疲惫', '累了', '好累', '懒洋洋', 'sleepy', 'tired', 'exhausted'], action: 'sleepy' },
  { words: ['无聊', '平淡', '平静', '平和', '发呆', 'neutral', 'calm', 'bored', 'peaceful'], action: 'neutral' },
]);

/**
 * bridge v1.1(T8 的实现)的固定复合标签:`开心` / `低落` / `平静`,再按唤醒度拼
 * `·有精神` / `·懒洋洋`。数值也一起给,但组合标签更直接 —— 这里先按它精确映射,
 * 免得「平静·懒洋洋」被泛化的「平静」规则吃掉、又丢掉「懒洋洋」这半句。
 *
 * @param {string} label 已转小写
 * @returns {string | null}
 */
function bridgeCompoundAction(label) {
  const has = (word) => label.includes(word);
  if (has('低落')) return 'sad';
  if (has('开心')) return has('有精神') ? 'excited' : 'happy';
  if (has('平静')) return has('懒洋洋') ? 'sleepy' : 'neutral';
  return null;
}

/** 数值兜底阈值(标签没命中时才用)。 */
const MOOD_THRESHOLDS = Object.freeze({  sadValence: -0.25, // <= 这个值就是难过(任务给的参考阈值)
  neutralValence: 0.15, // 低于它、又没到难过 → 平淡
  excitedArousal: 0.7, // 正面情绪 + 高唤醒 → 兴奋
  lowEnergy: 0.2, // 能量太低 → 困
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 心情快照 → 一个安全的气泡动作数组。
 *
 * 优先级:**中文标签**(deep-soul 自述的心情,比两个数值更直接) > valence/arousal/energy 数值 > `['happy']`。
 * 返回的永远是 `SAFE_MOOD_ACTIONS` 里的词,并且是**新数组**(调用方改了也不影响下一次)。
 *
 * @param {{label?: string, valence?: number, arousal?: number, energy?: number} | null | undefined} mood
 * @returns {string[]}
 */
export function moodActions(mood) {
  const hint = labelAction(mood);
  if (hint) return [hint];

  const valence = num(mood?.valence);
  const arousal = num(mood?.arousal);
  const energy = num(mood?.energy);

  if (valence !== null) {
    if (valence <= MOOD_THRESHOLDS.sadValence) return ['sad'];
    if (valence < MOOD_THRESHOLDS.neutralValence) {
      // 不高不低、又没精神 → 困;否则平平淡淡
      if (energy !== null && energy < MOOD_THRESHOLDS.lowEnergy) return ['sleepy'];
      return ['neutral'];
    }
    if (energy !== null && energy < MOOD_THRESHOLDS.lowEnergy) return ['sleepy'];
    if (arousal !== null && arousal >= MOOD_THRESHOLDS.excitedArousal) return ['excited'];
    return ['happy'];
  }

  return [...DEFAULT_MOOD_ACTIONS];
}

/** 标签里的关键词 → 动作;没有就用 null。 */
function labelAction(mood) {
  const label = String(mood?.label ?? '').toLowerCase().trim();
  if (!label) return null;
  // 先认 bridge v1.1 的固定复合标签(含唤醒度后缀),再走通用关键词
  const compound = bridgeCompoundAction(label);
  if (compound) return compound;
  for (const rule of LABEL_RULES) {
    for (const word of rule.words) {
      if (label.includes(word.toLowerCase().trim())) return rule.action;
    }
  }
  return null;
}

/**
 * 心情快照 → `pet_status` 里的一行(不含「心情:」前缀)。
 *
 * 例:`开心（valence 0.32 / arousal 0.41，记忆 5 条）`;
 * 没有数据时:`未知（bridge 未提供）`。
 *
 * @param {object | null | undefined} mood
 * @returns {string}
 */
export function describeMood(mood) {
  if (!mood || typeof mood !== 'object') return '未知（bridge 未提供）';

  const label = String(mood.label ?? '').trim();
  const valence = num(mood.valence);
  const arousal = num(mood.arousal);
  const memoryCount = num(mood.memoryCount);

  const parts = [];
  if (valence !== null && arousal !== null) parts.push(`valence ${valence.toFixed(2)} / arousal ${arousal.toFixed(2)}`);
  else if (valence !== null) parts.push(`valence ${valence.toFixed(2)}`);
  else if (arousal !== null) parts.push(`arousal ${arousal.toFixed(2)}`);
  if (memoryCount !== null) parts.push(`记忆 ${Math.max(0, Math.round(memoryCount))} 条`);

  const name = label || '未知';
  return parts.length ? `${name}（${parts.join('，')}）` : name;
}
