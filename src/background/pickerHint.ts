/**
 * The right-clicked element for the picker (P3-17 item 2). `contextMenus.onClicked` info is validated
 * here with Valibot and reduced to a `PickHint`: a sub-frame wins (the top-frame picker can only pick
 * the frame), then an image / video / audio, then a link. Anything else, or anything malformed, gives
 * no hint and the picker starts as before.
 */
import * as v from 'valibot';
import { isHintUrl, type PickHint } from '../core/picker/hint.js';

const HintUrl = v.custom<string>(isHintUrl);
const MenuClick = v.object({
  frameId: v.optional(v.pipe(v.number(), v.integer())),
  frameUrl: v.optional(v.unknown()),
  mediaType: v.optional(v.unknown()),
  srcUrl: v.optional(v.unknown()),
  linkUrl: v.optional(v.unknown()),
});
const Media = v.picklist(['image', 'video', 'audio']);

/** The hint for one context-menu click, or `null`. */
export function hintFromMenuClick(info: unknown): PickHint | null {
  const parsed = v.safeParse(MenuClick, info);
  if (!parsed.success) return null;
  const { frameId, frameUrl, mediaType, srcUrl, linkUrl } = parsed.output;
  if (frameId !== undefined && frameId !== 0) return v.is(HintUrl, frameUrl) ? { kind: 'frame', url: frameUrl } : null;
  if (mediaType !== undefined) return v.is(Media, mediaType) && v.is(HintUrl, srcUrl) ? { kind: mediaType, url: srcUrl } : null;
  return v.is(HintUrl, linkUrl) ? { kind: 'link', url: linkUrl } : null;
}
