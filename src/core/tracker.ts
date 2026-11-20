/**
 * The public issue tracker (Q-11, D-88). "Send report" opens a prefilled issue there in a new tab
 * (P2-15); the extension itself sends nothing. While the value was the placeholder only **Copy report**
 * was offered, and a public-channel build refuses it (release follow-up). The only accepted
 * value is exactly `https://github.com/<owner>/<repo>`.
 */
export const ISSUE_TRACKER_URL = 'https://github.com/Souayfan-Ali/Glassmere';

/** The value before the repository existed; refused like any invalid URL. */
const PLACEHOLDER = 'https://github.com/OWNER/REPO-PLACEHOLDER';
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)(?![A-Za-z0-9._-]*\.git$)[A-Za-z0-9._-]{1,100}$/;

/** The tracker's repository URL, or `null` for the placeholder and anything that is not a plain GitHub repository URL. */
export function trackerOf(url: string): string | null {
  if (url === PLACEHOLDER || !GITHUB_REPO.test(url)) return null;
  return url;
}
