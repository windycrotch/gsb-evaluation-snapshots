import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);

// UI formatting only. Scheduler/heartbeat clocks and the ledger's day boundary
// remain in the existing backend and keep their server-clock correction.
export function formatGameTime(
  value: string | number | null | undefined,
): string {
  if (value == null || value === "") return "";
  const date = dayjs(value);
  return date.isValid()
    ? date.tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss")
    : "";
}
