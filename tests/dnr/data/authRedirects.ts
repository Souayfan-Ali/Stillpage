/**
 * Login and payment redirects (P2-30, testing notes §5): navigations that carry the parameters a sign-in or
 * payment flow needs on its way back (`code`, `state`, `token`, `PayerID`, `SAMLResponse`, …). The
 * tracking-parameter pack may strip tracking keys from them, never one of these. Public URL shapes
 * written by hand; nothing is fetched.
 */
import type { DnrCase } from '../support/verdict.js';

const URLS: readonly string[] = [
  'https://example.com/auth/callback?code=4%2F0AX4XfWh&state=af0ifjsldkj&scope=openid%20email&authuser=0&prompt=consent',
  'https://example.com/oauth2/callback?code=abc&state=xyz&session_state=123',
  'https://example.com/signin-oidc#id_token=eyJ&state=xyz',
  'https://www.example.org/login/callback?code=M95&state=s1&iss=https%3A%2F%2Faccounts.google.com',
  'https://app.example.com/auth/microsoft/callback?code=0.AX&state=abc&session_state=def',
  'https://example.com/auth/apple/callback?code=c1&id_token=eyJ&state=s1&user=%7B%7D',
  'https://example.com/auth/github/callback?code=gh1&state=s1',
  'https://example.com/auth/facebook/callback?code=AQB&state=s1&fbclid_return=1',
  'https://example.com/oauth/twitter/callback?oauth_token=t1&oauth_verifier=v1',
  'https://example.com/saml/acs?SAMLResponse=PHNhbWxwOlJlc3BvbnNl&RelayState=%2Fdashboard',
  'https://sp.example.edu/Shibboleth.sso/SAML2/POST?RelayState=ss%3Amem%3Aabc',
  'https://example.okta.com/login/sessionCookieRedirect?token=20111&redirectUrl=https%3A%2F%2Fexample.com',
  'https://shop.example.com/checkout/paypal/return?token=EC-5Y366741JN879735H&PayerID=ABCD1234&paymentId=PAYID-1',
  'https://shop.example.com/checkout/success?session_id=cs_test_a1b2c3',
  'https://shop.example.com/checkout/complete?payment_intent=pi_3N&payment_intent_client_secret=pi_3N_secret_x&redirect_status=succeeded',
  'https://shop.example.com/checkout/return?setup_intent=seti_1&setup_intent_client_secret=seti_1_secret&redirect_status=succeeded',
  'https://shop.example.com/adyen/return?redirectResult=X3XtfGC9&type=complete',
  'https://shop.example.com/klarna/confirm?authorization_token=b4bd3423&order_id=1234',
  'https://shop.example.com/mollie/return?id=tr_WDqYK6vllg&order=1',
  'https://shop.example.com/3ds/complete?PaRes=eJzV&MD=abc&threeDSSessionData=xyz&cres=eyJ',
  'https://checkout.example.com/orders/1234/thank_you?key=wc_order_abc&order_id=1234',
  'https://www.paypal.com/checkoutnow?token=EC-5Y366741JN879735H&useraction=commit',
  'https://checkout.stripe.com/c/pay/cs_test_a1b2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0',
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code&scope=openid&state=s1&nonce=n1&code_challenge=c1&code_challenge_method=S256',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com&response_mode=query&state=s1&nonce=n1',
  'https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fexample.com&state=s1&allow_signup=true',
  'https://example.com/password/reset?token=reset-abc&email=user%40example.com',
  'https://example.com/verify-email?token=v1&expires=1800000000&signature=abc',
  'https://example.com/magic-link?token=ml1&redirect=%2Fapp',
  'https://example.com/invite/accept?invite_token=it1&ref=email',
];

export const AUTH_REDIRECTS: readonly DnrCase[] = URLS.map((url) => ({ url, type: 'main_frame', initiator: 'https://idp.example.net', expect: 'pass', because: 'login or payment redirect' }));

/** The query (and fragment) keys of `url`: none of them may be removed. */
export function keysOf(url: string): readonly string[] {
  const u = new URL(url);
  const fragment = new URLSearchParams(u.hash.slice(1));
  return [...new Set([...u.searchParams.keys(), ...fragment.keys()])];
}
