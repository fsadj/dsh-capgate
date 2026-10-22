/**
 * 失败分类：现在所有失败都走同一条"退化"路，无法区分"重试有意义"和"重试没意义"。
 *
 * 参考 ClawSentry 的 FailureClass，但只保留我们真的会遇到的五类。
 */
export const FailureKind = {
  NONE: 'none',
  INPUT: 'input_invalid',        // 参数/输出格式不对 → 可以让它修一次
  TIMEOUT: 'timeout',            // 超时 → 可以重试（更短上下文/更大预算）
  QUOTA: 'quota',                // 额度/限流 → 不要重试，直接退化
  UNAVAILABLE: 'unavailable',    // 服务/凭证不可用 → 不要重试
  INTERNAL: 'internal',          // 我们的 bug → 记录，退化
};

const QUOTA = /QUOTA|Insufficient Balance|rate.?limit|429/i;
const UNAVAILABLE = /MISSING_CREDENTIAL|no API key|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|abort/i;
const TIMEOUT = /timeout|timed out|aborted/i;

/** 从错误对象/字符串分类；默认 INTERNAL。 */
export function classifyFailure(err) {
  const msg = typeof err === 'string' ? err : String(err?.message ?? err ?? '');
  if (!msg) return FailureKind.NONE;
  if (QUOTA.test(msg)) return FailureKind.QUOTA;
  if (TIMEOUT.test(msg)) return FailureKind.TIMEOUT;
  if (UNAVAILABLE.test(msg)) return FailureKind.UNAVAILABLE;
  return FailureKind.INTERNAL;
}

/** 重试策略：只有超时/输入不合法值得再来一次。 */
export function shouldRetry(kind) {
  return kind === FailureKind.TIMEOUT || kind === FailureKind.INPUT;
}

/** 给用户/审计看的一句话 */
export function describeFailure(kind) {
  switch (kind) {
    case FailureKind.QUOTA: return '额度或限流（重试无意义，已退化）';
    case FailureKind.TIMEOUT: return '判定超时（已重试）';
    case FailureKind.UNAVAILABLE: return '模型/凭证不可用（已退化）';
    case FailureKind.INPUT: return '判定输出格式不合法（已要求修正一次）';
    case FailureKind.INTERNAL: return '内部错误（已记录）';
    default: return '';
  }
}
