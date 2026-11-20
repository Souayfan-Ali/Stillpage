/**
 * Static DNR rule shape the compiler emits (Chrome 145+, `topDomains` included). Strict: an unknown
 * key is an error, because static files silently ignore unknown keys and dynamic calls reject them
 * (S-07). Converter output is validated against this at the stage boundary.
 */
import { z } from 'zod';

export const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'] as const;
const METHODS = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'] as const;

const str = z.string();
const strs = z.array(str).readonly();
const HeaderInfo = z.strictObject({ header: str, values: strs.optional(), excludedValues: strs.optional() });
const ModifyHeader = z.strictObject({ header: str, operation: z.enum(['append', 'set', 'remove']), value: str.optional() });
const QueryKeyValue = z.strictObject({ key: str, value: str, replaceOnly: z.boolean().optional() });
const QueryTransform = z.strictObject({
  removeParams: strs.optional(),
  addOrReplaceParams: z.array(QueryKeyValue).readonly().optional(),
});
const UrlTransform = z.strictObject({
  scheme: str.optional(), host: str.optional(), port: str.optional(), path: str.optional(), query: str.optional(),
  queryTransform: QueryTransform.optional(), fragment: str.optional(), username: str.optional(), password: str.optional(),
});
const Redirect = z.strictObject({
  extensionPath: str.optional(), transform: UrlTransform.optional(), url: str.optional(), regexSubstitution: str.optional(),
});

const ActionSchema = z.strictObject({
  type: z.enum(['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests']),
  redirect: Redirect.optional(),
  requestHeaders: z.array(ModifyHeader).readonly().optional(),
  responseHeaders: z.array(ModifyHeader).readonly().optional(),
});

const ConditionSchema = z.strictObject({
  urlFilter: str.optional(),
  regexFilter: str.optional(),
  isUrlFilterCaseSensitive: z.boolean().optional(),
  initiatorDomains: strs.optional(),
  excludedInitiatorDomains: strs.optional(),
  requestDomains: strs.optional(),
  excludedRequestDomains: strs.optional(),
  topDomains: strs.optional(),
  excludedTopDomains: strs.optional(),
  resourceTypes: z.array(z.enum(RESOURCE_TYPES)).readonly().optional(),
  excludedResourceTypes: z.array(z.enum(RESOURCE_TYPES)).readonly().optional(),
  requestMethods: z.array(z.enum(METHODS)).readonly().optional(),
  excludedRequestMethods: z.array(z.enum(METHODS)).readonly().optional(),
  domainType: z.enum(['firstParty', 'thirdParty']).optional(),
  responseHeaders: z.array(HeaderInfo).readonly().optional(),
  excludedResponseHeaders: z.array(HeaderInfo).readonly().optional(),
});

export const DnrRuleSchema = z.strictObject({
  id: z.number().int().positive(),
  priority: z.number().int().positive().optional(),
  action: ActionSchema,
  condition: ConditionSchema,
});

export type DnrRule = z.infer<typeof DnrRuleSchema>;
export type DnrCondition = DnrRule['condition'];
export type DnrAction = DnrRule['action'];

/** `block`, `allow`, `allowAllRequests`, `upgradeScheme` (filter-pipeline notes §6.4); the rest go to `-x` rulesets. */
export const isSafeAction = (a: DnrAction): boolean => a.type !== 'redirect' && a.type !== 'modifyHeaders';
