# What Glassmere cannot do

Honest limits (product vision §4 principle 5). Draft of 2026-11-14 (P2-49).

Glassmere runs on Chrome's Manifest V3, where Chrome, not the extension, matches requests against
rules packaged in the extension. That keeps your browsing on your device and the extension asleep most
of the time, and it sets the limits below. Where a limit differs from uBlock Origin Lite (uBO Lite), the
comparison is with uBO Lite as measured in the Phase 0 spikes of 2026-11-13 (spike S-02c).

## Blocked malware pages have no "proceed" button

When you open a page on a known malware or phishing host, Chrome shows its own "blocked by an extension"
error page. There is no explanation page and no "proceed anyway" button. uBO Lite shows its own warning
page with a way through. To reach such a page anyway, add the site with the level Off in the dashboard's Sites section. (D-11;
an explanation page is a later feature.)

## Opening an ad or tracker address directly is not blocked

Rules that block ad and tracker requests apply to what pages load, not to an address you open yourself.
If you type or click through to a host that the lists name only as an ad or tracker server, the page
opens. uBO Lite blocks such a navigation and shows its warning page. Malware hosts, and the sites known
for pop-up ads below, are still blocked as whole pages. (D-11)

## A short gap after each update

Chrome removes every content script of an extension when it updates, and Glassmere registers them again
straight away: the anti-ad scripts first, then element hiding. A page that starts loading during those
few seconds is still filtered by the network rules, but may show leftover ad boxes or an ad script may
run, until you reload it. Rules updates are planned daily, so this happens about once a day. Budgets,
measured on a local unpacked update: anti-ad scripts back within 500 ms, everything within 3.5 s (p95,
performance notes §2.2). How long it takes after a real Chrome Web Store update is not yet measured.

## A short gap after Chrome starts

To keep every settings change quick, Chrome only keeps a small core of Glassmere's content scripts when it
closes: the pop-up guard, the privacy signal and part of the anti-ad scripts. The rest is registered again as
soon as Chrome starts, which takes about a second. A tab that Chrome restores at start-up is still filtered by
the network rules and the core scripts, but may show leftover ad boxes until you reload it (ADR-020). If that
start-up step fails, Glassmere tries it once more about 30 seconds later; if that fails too, the rest comes back
with your next settings change or the next time Chrome starts.

## Without access to all sites, blocking only

If you limit the extension's site access in Chrome ("On click" or "On specific sites"), Glassmere blocks
requests on every site but does nothing else anywhere, also not on the sites you granted:

- no hiding of leftover ad boxes and no anti-ad scripts where Chrome does not give access;
- no replacement of ad scripts with harmless stand-ins, and no header rules;
- sites known for pop-up ads show Chrome's error page instead of Glassmere's explanation page;
- "Do not sell or share" (GPC) and tracking-parameter removal have no effect.

The reason: Chrome lets a redirect rule that it cannot apply cancel the block beneath it, so the ad would
load. Glassmere installs those rules only while it has access to all sites (D-06). The toolbar panel says
when this applies and offers **Allow on all sites**.

## Right after you switch a site Off, one more load may be filtered

Chrome applies a rule change to new page loads a moment after it accepts the change. If you reload a
page immediately after setting the site to Off (or pausing, or changing its level), that one load can
still be filtered with the old settings; the next reload is right. This was seen in automated tests on a
busy machine, about once in twelve tries. If a page still looks blocked right after a change, reload it
once more.

## Pop-ups: what the guard cannot catch

<!-- guard-scripts: registered -->
Status in this build: guard scripts registered when the user turns the guard on. The pop-up guard (Smart or Strict) is off by
default; sites known for pop-up ads are blocked either way.

Pop-ups are stopped in two ways:

- **Known pop-up ad sites** (always on): when any page opens a site from the pop-up lists, Chrome shows
  Glassmere's blocked page instead. With the guard on, it closes a tab the page opened by itself; otherwise
  it offers **Close tab**, **Go back** and **Proceed once**. This page needs access to all sites; without it Chrome shows
  its error page instead (see "Without access to all sites" above). A site that joined the lists after
  the last full release is blocked, but its tab is not closed for you. If you open a listed site on
  purpose (typed, bookmark), you meet the blocked page too and choose **Proceed once**.
- **The guard** (optional, Smart or Strict): watches the windows and tabs a page opens and blocks those
  you did not ask for, judged by the click that came before. It runs in the top page only.

What **Smart** cannot catch, and what covers it:

- A window opened right after you click a real button or link on the page (a play button, a "next"
  link). Smart only judges whether there was a real click, so it lets this through. **Strict** blocks it
  (and asks you to allow wanted windows), and the pop-up lists block the destination if it is known.
- A window opened from inside an embedded frame from another site (a video player, an ad frame). The
  guard does not run in frames. The lists' anti-ad scripts for that frame's site and the pop-up lists
  still apply.
- A window opened through a brand-new frame that a page creates and uses at once. The guard can miss it;
  the pop-up lists still judge the destination.

Sign-in and payment windows from a short list of providers are always let through, so that signing in
or paying keeps working in Strict. Two of them, Stripe Checkout (`checkout.stripe.com`) and Microsoft
sign-in (`login.microsoftonline.com`), are let through for the whole site: on Stripe any shop's payment
page lives there, and Microsoft puts the organisation's name first in the address, so a narrower entry
would either break real payments or sign-ins or let the same pages through anyway. A page could therefore
open a payment or sign-in page that someone else set up on those sites, the same as it could for any
sign-in provider on the list. The guard does not judge what a sign-in or payment page asks for; check
the address and the name shown before you sign in or pay.

Neither the guard nor the lists stop a window you open yourself (middle-click, "Open in new tab").
Choose **Allow pop-ups on this site** in the toolbar panel when a site's wanted windows are blocked.

### Pop-up sites that the ad lists also block

About 480 of the known pop-up ad sites (for example a-ads.com) are also blocked as whole pages by the
ad lists. For these Glassmere shows its blocked page too, not Chrome's error page, with two differences:

- **Proceed once opens only the one address shown on the page**, in that tab. Any other address on the
  same site meets the blocked page again. This keeps a site's other addresses that the malware lists flag
  blocked; the one address you choose could still be one of them.
- **Allow pop-ups on this site** does not reach these sites: the ad lists block them as pages anyway, as
  they did before.

These sites are picked when a full version of Glassmere is built. If the lists stop blocking such a site,
or start allowing it, between versions, Glassmere may keep treating it this way for up to 7 days (48 hours
if a malware list adds it). The page is still stopped in that time; only the Allow pop-ups setting and a
new list exception wait for the next version.

(Rule order, for reviewers: pop-up rules 1–3, list rules 10–1,999,999, these sites' blocked page
5,000,000 and Proceed once 5,000,001, your own rules from 10,000,000, site switches 14,000,000, Off and
pause 15,000,000. Chrome honours priorities only up to 16,777,215, so every band stays below that.)
Replacing ad scripts with harmless stand-ins also needs access to all sites.

## Hard sites

Some sites, video sites above all, change how they serve ads more often than filter lists can follow, and
some of their countermeasures need code that MV3 extensions cannot run. Glassmere does not promise to
block ads on any particular site. Use the breakage flow ("Something wrong on this page?") to report
what you see.

## Scriptlets in a frame its same-origin parent prepared

A page can create a frame of its own site and change that frame's built-in JavaScript functions before
the frame loads (Chrome keeps the frame's first, empty window for a same-site page). Glassmere's
scriptlets run inside that prepared window, where no built-in can be trusted, so the page can make
them misbehave or run with other arguments. This gives the page nothing it did not already have: the
scriptlets run with the page's own rights, on the page's own site, and read nothing private. It only
means a site can defeat Glassmere's fixes on its own pages. Nothing outside that frame is affected, no
error reaches the page and nothing is stored (hostile-page test J15).

## Hiding and un-hiding in tabs that are already open

What you hide with "Hide something", and what you remove from the list, applies at once in the other open
tabs of that site, frames included. Two cases still need a reload of the page:

- The first thing you ever hide on a site reaches other tabs of that site only after they reload: until
  then the part of Glassmere that applies your hidden items is not set up for that site.
- In the tab where you picked the element, a Remove shows it again only after a reload: the picker keeps
  its own copy of the hide in that tab until the page reloads.

## Other limits in this version

- Your own filter lists and custom rules are not supported yet; you can hide elements with the element
  hider.
- Pages opened from files (`file://`) are not filtered.
- Private windows are filtered only if you allow the extension in incognito in Chrome's extension
  settings.
- Chrome caps the number of rules and patterns an extension may use. Optional packs that would not fit
  are refused with a message rather than enabled partly.
- Counts in the toolbar panel come from Chrome for the current page. There is no lifetime "ads blocked"
  total, because Chrome cannot provide an exact one.
- English only.
