/**
 * The provider allowlist compiled into the sentinel (P2-58, pop-up notes §8, rule G5): `host → path prefixes`
 * from `lists/popup-allow.json`. A unit test lints the source and checks this map equals its compiled form.
 */
import type { CompiledAllowlist } from '../../core/popup/allowlist.js';

export const PROVIDER_ALLOWLIST: CompiledAllowlist = {'accounts.google.com': ['/o/oauth2', '/signin'], 'appleid.apple.com': ['/auth/authorize'], 'checkout.stripe.com': ['/'], 'github.com': ['/login/oauth'], 'login.live.com': ['/oauth20_authorize.srf'], 'login.microsoftonline.com': ['/'], 'pay.google.com': ['/gp/p'], 'www.amazon.com': ['/ap/oa'], 'www.facebook.com': ['/dialog/oauth'], 'www.linkedin.com': ['/oauth'], 'www.paypal.com': ['/checkoutnow', '/signin'], 'x.com': ['/i/oauth2']};
