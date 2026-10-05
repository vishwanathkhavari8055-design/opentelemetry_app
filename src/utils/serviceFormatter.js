const KEYWORDS = [
  'TIOTSSODASHBOARD', 'TIOTOPS', 'IOTOPS', 'TIOT', 'IOT', 'SERVICE', 'DASHBOARD', 'INITIALIZER', 'CIM', 'SSO', 'POC', 'SVC', 'OPS', 'SCHEMA', 'TELEMETRY'
];

const keywordRegex = new RegExp(`(${KEYWORDS.join('|')})`, 'gi');

const WORD_MAP = {
  'TIOTSSODASHBOARD': 'TIoTSSODashboard',
  'IOTOPS': 'IoTOps',
  'TIOTOPS': 'TIoTOps',
  'IOT': 'IoT',
  'TIOT': 'TIoT',
  'OPS': 'Ops',
  'SVC': 'Svc',
  'POC': 'POC',
  'SSO': 'SSO',
  'CIM': 'CIM',
  'SERVICE': 'Service',
  'DASHBOARD': 'Dashboard',
  'INITIALIZER': 'Initializer',
  'SCHEMA': 'Schema',
  'TELEMETRY': 'Telemetry',
  'UNKNOWN': 'Unknown',
};

/**
 * Formats a service name (e.g. "COCAPPSERVICE" -> "Cocapp Service", "IOTOPSCIMSERVICE" -> "IoTOps CIM Service").
 * Keeps lowercase-to-uppercase transitions or splits them into readable words, and falls back to Title Case.
 */
export function formatServiceName(name) {
  if (!name) return '';
  if (name.toUpperCase() === 'ALL') return 'ALL';

  // Check if the original name is all-uppercase or all-lowercase
  const isUpper = /^[A-Z0-9\s_-]+$/.test(name);
  const isLower = /^[a-z0-9\s_-]+$/.test(name);

  // Insert spaces around known keywords case-insensitively, preserving original casing
  let processed = name.replace(keywordRegex, ' $1 ');

  // Replace underscores and hyphens with space
  processed = processed.replace(/[-_]/g, ' ');

  // Split, format each word, and filter out empty tokens
  const formattedWords = processed
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      const upper = word.toUpperCase();
      if (WORD_MAP[upper]) {
        return WORD_MAP[upper];
      }
      // If the original input was all uppercase or all lowercase, apply title case
      if (isUpper || isLower) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      // Otherwise, keep the original capitalization!
      return word;
    });

  const joined = formattedWords.join(' ');

  // Post-process to merge 'IoT Ops' -> 'IoTOps'
  return joined.replace(/\bIoT Ops\b/g, 'IoTOps');
}
