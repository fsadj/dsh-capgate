/**
 * 最小 Macaroon(第一方 caveat 版)——gate minter 的 TS 侧对应实现。
 *
 * 签名链与 pymacaroons 第一方语义一致:
 *   sig0 = HMAC_SHA1(key, identifier)
 *   sigN = HMAC_SHA1(sigN-1, caveat_id)
 * 验证 = 重算链并比对终态签名,再逐条核对 caveat 谓词。
 * WP1 只需第一方 caveat;第三方 discharge(caveat key)是后续条目。
 */
import { createHmac, randomBytes } from 'node:crypto'

export interface Macaroon {
  identifier: string
  caveats: string[]
  signature: string            // hex
}

export function mint(identifier: string, key: Buffer | string,
                     caveats: string[]): Macaroon {
  let sig = createHmac('sha1', key).update(identifier).digest()
  const saved: string[] = []
  for (const c of caveats) {
    sig = createHmac('sha1', sig).update(c).digest()
    saved.push(c)
  }
  return { identifier, caveats: saved, signature: sig.toString('hex') }
}

export type CaveatPredicate = (caveat: string) => boolean

/**
 * 验证:重算签名链(与 mint 同序)+ 每条 caveat 必须被谓词表满足
 * (exact 表或 general 谓词;未知 caveat → 不满足,fail-closed)。
 * 与 pymacaroons Verifier 的 satisfy_exact/satisfy_general 语义对齐。
 */
export function verify(mac: Macaroon, key: Buffer | string,
                       exact: Set<string>,
                       general: CaveatPredicate[] = []): boolean {
  let sig = createHmac('sha1', key).update(mac.identifier).digest()
  for (const c of mac.caveats) {
    sig = createHmac('sha1', sig).update(c).digest()
    if (!(exact.has(c) || general.some(p => p(c)))) return false
  }
  return sig.toString('hex') === mac.signature
}

export function newRid(): string {
  return randomBytes(9).toString('base64url')
}
