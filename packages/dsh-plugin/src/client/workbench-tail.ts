/**
 * Tail-pin 门禁:贴底跟随只由用户滚动状态决定(上游 #27 方向)。
 *
 * parked 是粘性快照:置 true 门槛宽(到尾即认领),置 false 门槛严(必须是
 * 用户驱动的 scroll——指针按下或解除窗口内)。publishLayout(RO/Mutation
 * 驱动)绝不碰它:流式渲染期的自发 scroll(scroll anchoring/宿主重排)不是
 * 用户离开,不得解除贴底;写回判定读快照,不用写回前现算值。
 * (#26 长答复跟随依赖此语义)
 */

/** 贴底判定阈值(px):scrollHeight - scrollTop - clientHeight 落在此内即视为贴底。 */
export const TAIL_PARK_THRESHOLD_PX = 8;
/** 写回宽限(ms):用户手势宽限内的 RO/Mutation 回调禁止 tail-pin 写回,防止抢滚动条位置。 */
export const TAIL_PIN_GRACE_MS = 600;
/** 解除贴底的用户手势窗口(ms):离尾的 scroll 仅在指针按下或此窗口内才释放 parked;与写回宽限是两个不同常量。 */
export const TAIL_UNPARK_WINDOW_MS = 400;

export interface TailPinState {
  /** 粘性快照:到尾即认领,解除必须用户驱动;不是写回前现算值。 */
  readonly parked: boolean;
  readonly pointerHeld: boolean;
  readonly lastDrivenAt: number;
  readonly now: number;
}

/**
 * 到尾即跟随到底;指针按下或用户手势宽限内绝不写回抢位置。
 * scrollTop 赋同值不触发 scroll,每帧写同值无害,故不检查高度变化。
 */
export function shouldPinTail(state: TailPinState): boolean {
  if (!state.parked) return false;
  if (state.pointerHeld) return false;
  return state.now - state.lastDrivenAt >= TAIL_PIN_GRACE_MS;
}

export function isParkedAtTail(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= TAIL_PARK_THRESHOLD_PX;
}
