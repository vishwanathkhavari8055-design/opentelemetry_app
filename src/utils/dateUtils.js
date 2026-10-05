const fullTimestampFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false
});

const timeOnlyFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false
});

/**
 * Formats an ISO timestamp into a full date and 24-hour time with milliseconds.
 * Example: "06 Apr 2026 13:12:14.456"
 */
export const formatFullTimestamp = (isoString) => {
  if (!isoString) return "--";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString; // Return raw string if invalid to avoid crash
  return fullTimestampFormatter.format(date).replaceAll(',', '');
};

/**
 * Formats an ISO timestamp into "YYYY-MM-DD HH:mm:ss.SSS" (local time).
 * Example: "2026-05-22 13:12:14.456"
 *
 * Used wherever a date+time stamp is rendered on a single line. Time-only
 * formats (formatTimeOnly) are misleading when a list can span multiple
 * days — the user can't tell whether "13:12" is today's or last week's.
 */
export const formatIsoDateTime = (isoString) => {
  if (!isoString) return "--";
  let date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    if (!Number.isNaN(Number(isoString))) {
      // OTel/OpenObserve can emit microseconds-since-epoch as a number;
      // values that big aren't valid ms, so rescale.
      let val = Number.parseFloat(isoString);
      if (val > 1e14) val = val / 1000;
      date = new Date(val);
    }
    if (Number.isNaN(date.getTime())) return String(isoString);
  }
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${hh}:${mm}:${ss}.${ms}`;
};

/**
 * Formats an ISO timestamp into a 24-hour time with milliseconds only.
 * Example: "13:12:14.456"
 */
export const formatTimeOnly = (isoString) => {
  if (!isoString) return "--";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    // If it's a numeric string (epoch), try to parse it
    if (!Number.isNaN(Number(isoString))) {
      const epochDate = new Date(Number.parseFloat(isoString));
      if (!Number.isNaN(epochDate.getTime())) return timeOnlyFormatter.format(epochDate);
    }
    return isoString; // Return raw string if still invalid
  }
  return timeOnlyFormatter.format(date);
};
