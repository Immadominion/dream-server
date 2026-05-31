/**
 * Phoenix money fields come back as amount objects like
 * `{ value, decimals, ui }` rather than plain numbers. Reading them as scalars
 * silently zeroes collateral, size, entry price, etc. This mirrors the Dream
 * client's `_toDouble` so server + client agree on every number.
 */

export function toNumber(value: unknown): number {
    if (value == null) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
        const n = Number.parseFloat(value);
        return Number.isFinite(n) ? n : 0;
    }
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const ui = obj.ui ?? obj.uiAmount ?? obj.ui_amount;
        if (ui != null) return toNumber(ui);

        const raw = obj.value ?? obj.amount;
        const decimals = obj.decimals;
        if (raw != null && decimals != null) {
            const rawNum = toNumber(raw);
            const scale = toNumber(decimals);
            return scale > 0 ? rawNum / 10 ** Math.trunc(scale) : rawNum;
        }
    }
    return 0;
}

export function toInt(value: unknown): number {
    return Math.trunc(toNumber(value));
}
