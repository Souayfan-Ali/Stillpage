/**
 * Must-allow rows (testing notes §5): what users need to keep working. ~160 `main_frame` navigations to
 * top sites, sign-in, payment and SSO pages (no rule may stop them — S-18's list), the top sites'
 * own first-party resources, and the third-party services pages embed for payment, sign-in,
 * captcha, fonts, maps, video and public CDNs, each from four unrelated sites. A row passes when
 * nothing stops the request. Public URLs written by hand; nothing is fetched.
 */
import type { DnrCase } from '../support/verdict.js';

const TOP: readonly string[] = ['google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'wikipedia.org', 'en.wikipedia.org',
  'amazon.com', 'amazon.de', 'amazon.co.uk', 'amazon.co.jp', 'reddit.com', 'yahoo.com', 'bing.com', 'duckduckgo.com', 'baidu.com',
  'yandex.ru', 'vk.com', 'whatsapp.com', 'web.whatsapp.com', 'tiktok.com', 'linkedin.com', 'netflix.com', 'microsoft.com',
  'live.com', 'outlook.live.com', 'office.com', 'apple.com', 'icloud.com', 'github.com', 'gitlab.com', 'stackoverflow.com',
  'twitch.tv', 'discord.com', 'telegram.org', 'web.telegram.org', 'pinterest.com', 'ebay.com', 'ebay.de', 'aliexpress.com',
  'alibaba.com', 'walmart.com', 'target.com', 'etsy.com', 'booking.com', 'airbnb.com', 'tripadvisor.com', 'expedia.com',
  'cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'spiegel.de', 'lemonde.fr',
  'repubblica.it', 'elpais.com', 'zoom.us', 'slack.com', 'notion.so', 'dropbox.com', 'drive.google.com', 'docs.google.com',
  'mail.google.com', 'maps.google.com', 'news.google.com', 'imdb.com', 'spotify.com', 'open.spotify.com', 'soundcloud.com',
  'quora.com', 'medium.com', 'wordpress.com', 'blogger.com', 'tumblr.com', 'weather.com', 'espn.com', 'nba.com', 'fifa.com',
  'adobe.com', 'canva.com', 'figma.com', 'openai.com', 'chatgpt.com', 'deepl.com', 'gemini.google.com', 'samsung.com',
  'naver.com', 'qq.com', 'weibo.com', 'rakuten.co.jp', 'mercadolibre.com', 'ok.ru', 'mail.ru', 'globo.com', 'uol.com.br'];
const SIGNIN: readonly string[] = [
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code&scope=openid%20email',
  'https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn',
  'https://accounts.google.com/gsi/select?client_id=123.apps.googleusercontent.com',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com',
  'https://login.live.com/oauth20_authorize.srf?client_id=abc',
  'https://appleid.apple.com/auth/authorize?client_id=com.example&redirect_uri=https%3A%2F%2Fexample.com&response_type=code%20id_token&response_mode=form_post',
  'https://www.facebook.com/v19.0/dialog/oauth?client_id=123&redirect_uri=https%3A%2F%2Fexample.com%2Fcb',
  'https://m.facebook.com/login.php',
  'https://github.com/login/oauth/authorize?client_id=abc&scope=read:user',
  'https://github.com/login', 'https://gitlab.com/oauth/authorize?client_id=abc',
  'https://twitter.com/i/oauth2/authorize?response_type=code&client_id=abc', 'https://x.com/i/flow/login',
  'https://api.twitter.com/oauth/authenticate?oauth_token=abc',
  'https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=abc',
  'https://discord.com/oauth2/authorize?client_id=123&scope=identify',
  'https://id.twitch.tv/oauth2/authorize?client_id=abc&response_type=token',
  'https://www.amazon.com/ap/oa?client_id=amzn1&scope=profile',
  'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com',
  'https://oauth.vk.com/authorize?client_id=123', 'https://oauth.yandex.ru/authorize?response_type=token&client_id=abc',
  'https://slack.com/openid/connect/authorize?scope=openid&client_id=abc',
  'https://zoom.us/oauth/authorize?response_type=code&client_id=abc',
  'https://www.dropbox.com/oauth2/authorize?client_id=abc&response_type=code',
  'https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=abc',
  'https://login.yahoo.com/?.src=ym', 'https://steamcommunity.com/openid/login?openid.mode=checkid_setup',
  'https://store.steampowered.com/login/', 'https://accounts.spotify.com/authorize?client_id=abc&response_type=code',
  'https://www.reddit.com/api/v1/authorize?client_id=abc&response_type=code&state=x&redirect_uri=https%3A%2F%2Fexample.com&duration=temporary&scope=identity'];
const PAYMENT: readonly string[] = [
  'https://www.paypal.com/checkoutnow?token=EC-XXXX', 'https://www.paypal.com/signin?returnUri=%2Fmyaccount',
  'https://www.paypal.com/webapps/hermes?token=123', 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3',
  'https://hooks.stripe.com/3d_secure_2/hosted?merchant=acct_1', 'https://js.stripe.com/v3/three-ds-2-challenge.html',
  'https://pay.google.com/gp/w/home/paymentmethods', 'https://payments.google.com/payments/home',
  'https://www.klarna.com/us/', 'https://pay.klarna.com/eu/checkout', 'https://www.sandbox.paypal.com/checkoutnow?token=EC-1',
  'https://checkout.shopify.com/12345/checkouts/abc', 'https://shop.app/pay/authentication',
  'https://secure.adyen.com/hpp/pay.shtml', 'https://checkoutshopper-live.adyen.com/checkoutshopper/threeDS2.shtml',
  'https://3dsecure.example-bank.com/acs/challenge', 'https://secure5.arcot.com/acspage/cap',
  'https://www.mollie.com/checkout/select-method/abc', 'https://link.com/', 'https://www.afterpay.com/en-US/checkout'];
const SSO: readonly string[] = [
  'https://example.okta.com/oauth2/default/v1/authorize?client_id=abc', 'https://login.okta.com/',
  'https://example.auth0.com/authorize?client_id=abc&response_type=code', 'https://example.onelogin.com/login2/',
  'https://sso.example.com/adfs/ls/?SAMLRequest=abc', 'https://idp.example.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=abc',
  'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=abc',
  'https://accounts.zoho.com/oauth/v2/auth?scope=a&client_id=b', 'https://signin.aws.amazon.com/oauth?response_type=code',
  'https://cognito-idp.us-east-1.amazoncognito.com/oauth2/authorize?client_id=abc',
  'https://id.atlassian.com/login', 'https://login.gov/'];

/** `www.` in front of bare registrable domains, as the sites redirect to. */
const siteHost = (h: string): string => (h.split('.').length === 2 && !h.startsWith('www.') ? `www.${h}` : h);

const navigations = (urls: readonly string[], group: string): DnrCase[] =>
  urls.map((url) => ({ url, type: 'main_frame', expect: 'pass' as const, because: `${group} navigation` }));

/** A top site's own script, image and API call, each requested by the site itself. */
const FIRST_PARTY: readonly (readonly [string, string])[] = [
  ['/static/js/main.4f2a.js', 'script'],
  ['/images/logo.png', 'image'],
  ['/api/v1/session', 'xmlhttprequest'],
];

const firstParty = (): DnrCase[] =>
  TOP.flatMap((h) =>
    FIRST_PARTY.map(([pathname, type]) => ({
      url: `https://${siteHost(h)}${pathname}`,
      type,
      initiator: `https://${siteHost(h)}`,
      expect: 'pass' as const,
      because: `first-party resource of ${h}`,
    })),
  );

/** [url, type, group] of services embedded by other sites. */
const SERVICES: readonly (readonly [string, string, string])[] = [
  ['https://js.stripe.com/v3/', 'script', 'payment'],
  ['https://m.stripe.network/inner.html', 'sub_frame', 'payment'],
  ['https://www.paypal.com/sdk/js?client-id=abc&currency=EUR', 'script', 'payment'],
  ['https://www.paypalobjects.com/api/checkout.js', 'script', 'payment'],
  ['https://pay.google.com/gp/p/js/pay.js', 'script', 'payment'],
  ['https://applepay.cdn-apple.com/jsapi/v1/apple-pay-sdk.js', 'script', 'payment'],
  ['https://js.braintreegateway.com/web/3.97.2/js/client.min.js', 'script', 'payment'],
  ['https://checkoutshopper-live.adyen.com/checkoutshopper/sdk/5.53.0/adyen.js', 'script', 'payment'],
  ['https://x.klarnacdn.net/kp/lib/v1/api.js', 'script', 'payment'],
  ['https://accounts.google.com/gsi/client', 'script', 'sign-in'],
  ['https://apis.google.com/js/platform.js', 'script', 'sign-in'],
  ['https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js', 'script', 'sign-in'],
  ['https://alcdn.msauth.net/browser/2.38.0/js/msal-browser.min.js', 'script', 'sign-in'],
  ['https://cdn.auth0.com/js/auth0/9.23.0/auth0.min.js', 'script', 'sign-in'],
  ['https://www.google.com/recaptcha/api.js', 'script', 'captcha'],
  ['https://www.gstatic.com/recaptcha/releases/abc123/recaptcha__en.js', 'script', 'captcha'],
  ['https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc', 'sub_frame', 'captcha'],
  ['https://www.recaptcha.net/recaptcha/api.js', 'script', 'captcha'],
  ['https://js.hcaptcha.com/1/api.js', 'script', 'captcha'],
  ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html', 'sub_frame', 'captcha'],
  ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'script', 'captcha'],
  ['https://fonts.googleapis.com/css2?family=Inter:wght@400;700', 'stylesheet', 'fonts'],
  ['https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2', 'font', 'fonts'],
  ['https://use.typekit.net/abc1def.css', 'stylesheet', 'fonts'],
  ['https://kit.fontawesome.com/abc123.js', 'script', 'fonts'],
  ['https://maps.googleapis.com/maps/api/js?key=abc&callback=initMap', 'script', 'maps'],
  ['https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js', 'script', 'maps'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'sub_frame', 'video'],
  ['https://www.youtube.com/iframe_api', 'script', 'video'],
  ['https://player.vimeo.com/video/76979871', 'sub_frame', 'video'],
  ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', 'image', 'video'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'script', 'cdn'],
  ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js', 'script', 'cdn'],
  ['https://unpkg.com/react@18.3.1/umd/react.production.min.js', 'script', 'cdn'],
  ['https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'script', 'cdn'],
  ['https://code.jquery.com/jquery-3.7.1.min.js', 'script', 'cdn'],
  ['https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css', 'stylesheet', 'cdn'],
  ['https://cdn.shopify.com/s/files/1/0001/0001/files/logo.png', 'image', 'cdn'],
  ['https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg', 'image', 'cdn'],
  ['https://pbs.twimg.com/media/abc.jpg', 'image', 'cdn'],
  ['https://m.media-amazon.com/images/I/41abc.jpg', 'image', 'cdn'],
  ['https://i.imgur.com/abc123.png', 'image', 'cdn'],
  ['https://cdn.discordapp.com/attachments/1/2/image.png', 'image', 'cdn'],
  ['https://raw.githubusercontent.com/user/repo/main/README.md', 'xmlhttprequest', 'cdn'],
  ['https://api.github.com/repos/user/repo', 'xmlhttprequest', 'api'],
  ['https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/x', 'xmlhttprequest', 'api'],
  ['https://abc.supabase.co/rest/v1/items?select=*', 'xmlhttprequest', 'api'],
  ['https://widget.intercom.io/widget/abc123', 'script', 'support'],
  ['https://static.zdassets.com/ekr/snippet.js?key=abc', 'script', 'support'],
  ['https://embed.tawk.to/abc/default', 'script', 'support'],
];

/** Unrelated, fictitious sites that embed the services. */
const EMBEDDERS = ['https://www.daily-news-site.com', 'https://blog.recipes-world.net', 'https://shop.store-front.co.uk', 'https://app.saas-tool.io'];

const services = (): DnrCase[] =>
  SERVICES.flatMap(([url, type, group]) =>
    EMBEDDERS.map((initiator) => ({ url, type, initiator, expect: 'pass' as const, because: `${group}: ${new URL(url).hostname}` })),
  );

export const MUST_ALLOW: readonly DnrCase[] = [
  ...navigations(TOP.map((h) => `https://${siteHost(h)}/`), 'top-site'),
  ...navigations(SIGNIN, 'sign-in'),
  ...navigations(PAYMENT, 'payment'),
  ...navigations(SSO, 'sso'),
  ...firstParty(),
  ...services(),
];
