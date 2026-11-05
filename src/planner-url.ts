// My Desk 주소. 2026-11-05 집이 .com 하나로 옮겼다(메인 레포 lib/site-domains.ts).
// 예전 주소의 /api도 계속 받지만, 플러그인은 집으로 바로 가게 한다.

export const HOME_PLANNER_URL = "https://mydesk.thebookshift.com";
export const LEGACY_PLANNER_URL = "https://my-desk-snowy.vercel.app";

/**
 * 저장된 주소가 예전 기본값이면 집으로 바꾼다. 사용자가 직접 넣은 다른 주소(자가 호스팅)는 그대로 둔다.
 * Object.assign으로 기본값을 깔아도, 한 번 저장된 설정은 예전 기본값을 그대로 들고 있기 때문이다.
 */
export function migratePlannerUrl(saved: string | null | undefined): string {
  const trimmed = (saved ?? "").trim();
  if (!trimmed) return HOME_PLANNER_URL;
  if (trimmed.replace(/\/+$/, "").toLowerCase() === LEGACY_PLANNER_URL) return HOME_PLANNER_URL;
  return trimmed;
}
