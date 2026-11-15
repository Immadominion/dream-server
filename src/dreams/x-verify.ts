/**
 * Proves a dream owner controls the X account they link.
 *
 * Anyone can paste someone else's viral post, so a link alone is worthless as
 * social proof. We only accept a post that (a) is public, (b) is authored by
 * the handle in its URL, and (c) contains this dream's id — 12 random base58
 * characters that only exist after the dream is created, so only the account
 * holder could have posted it. (We match the id rather than the full link
 * because X truncates long link text.) Checked via X's public oEmbed endpoint.
 */

export class XVerifyError extends Error {}

const OEMBED = "https://publish.x.com/oembed";
const TIMEOUT_MS = 8_000;

export interface VerifiedXPost {
    url: string;
    handle: string;
}

export function parseXPostUrl(url: string): { handle: string; statusId: string } | null {
    const m = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:[/?#].*)?$/.exec(url.trim());
    return m ? { handle: m[1]!, statusId: m[2]! } : null;
}

export async function verifyXPost(
    url: string,
    dreamId: string,
    fetchImpl: typeof fetch = fetch
): Promise<VerifiedXPost> {
    const parsed = parseXPostUrl(url);
    if (!parsed) throw new XVerifyError("Paste a link to a post on X");

    const query = new URLSearchParams({
        url: `https://x.com/${parsed.handle}/status/${parsed.statusId}`,
        omit_script: "1",
        dnt: "1",
    });
    let body: { author_url?: unknown; html?: unknown };
    try {
        const res = await fetchImpl(`${OEMBED}?${query}`, {
            redirect: "follow",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 404) throw new XVerifyError("That post doesn't exist or isn't public");
        if (!res.ok) throw new XVerifyError("Couldn't reach X to verify — try again in a minute");
        body = (await res.json()) as typeof body;
    } catch (err) {
        if (err instanceof XVerifyError) throw err;
        throw new XVerifyError("Couldn't reach X to verify — try again in a minute");
    }

    // oEmbed reports the real author; a URL can name any handle.
    const author = typeof body.author_url === "string" ? /\/([A-Za-z0-9_]{1,15})\/?$/.exec(body.author_url)?.[1] : undefined;
    if (!author || author.toLowerCase() !== parsed.handle.toLowerCase()) {
        throw new XVerifyError("That post wasn't written by the account in the link");
    }

    const html = typeof body.html === "string" ? body.html : "";
    if (!html.includes(dreamId)) {
        throw new XVerifyError("Your post must include your Dream ID so we know it's yours");
    }

    return { url: `https://x.com/${author}/status/${parsed.statusId}`, handle: author };
}
