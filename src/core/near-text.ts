/**
 * @fileoverview D2：评论文本近邻指纹（归一化 + 64-bit simhash）。
 * 纯本地、无云 API；不做图片 pHash。
 * @module core/near-text
 */

/**
 * 归一化评论文本：NFKC、小写、去空白与常见标点、全角数字/字母折半角。
 */
export function normalizeCommentText(text: string): string {
  let s = text.normalize('NFKC').toLowerCase();
  // 全角 a-zA-Z0-9 → 半角（NFKC 通常已处理，再保险）
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // 去空白与常见中英文标点
  s = s.replace(/[\s\u3000]+/g, '');
  s = s.replace(/[.,!?;:'"，。！？；：、""''（）()\[\]【】《》<>…—\-_/\\|#@*`~^=+]+/g, '');
  return s;
}

/** 字符 bigram → 64-bit simhash（用 number 存低 32 + 高 32 不安全；用 bigint） */
export function simhash64(normalized: string): bigint {
  if (!normalized) return 0n;
  const bits = new Array<number>(64).fill(0);
  const grams: string[] = [];
  if (normalized.length === 1) {
    grams.push(normalized + normalized);
  } else {
    for (let i = 0; i < normalized.length - 1; i++) {
      grams.push(normalized.slice(i, i + 2));
    }
  }
  for (const g of grams) {
    const h = fnv1a64(g);
    for (let b = 0; b < 64; b++) {
      if ((h >> BigInt(b)) & 1n) bits[b] += 1;
      else bits[b] -= 1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (bits[b] > 0) out |= 1n << BigInt(b);
  }
  return out;
}

function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash;
}

export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export function fingerprintHex(fp: bigint): string {
  return fp.toString(16).padStart(16, '0');
}

export function fingerprintFromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/**
 * 计算评论近邻指纹（hex）。空归一化结果返回 null（跳过近邻门禁）。
 */
export function commentNearFingerprint(text: string): string | null {
  const norm = normalizeCommentText(text);
  if (!norm) return null;
  return fingerprintHex(simhash64(norm));
}

/**
 * 两文案是否近邻（Hamming ≤ threshold）。
 */
export function isNearDuplicateText(a: string, b: string, threshold: number): boolean {
  const fa = commentNearFingerprint(a);
  const fb = commentNearFingerprint(b);
  if (!fa || !fb) return false;
  return hamming64(fingerprintFromHex(fa), fingerprintFromHex(fb)) <= threshold;
}
