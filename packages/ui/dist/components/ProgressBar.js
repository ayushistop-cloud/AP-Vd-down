import { jsx as _jsx } from "react/jsx-runtime";
export function ProgressBar({ value, label }) {
    const indeterminate = value === undefined || !Number.isFinite(value);
    const clamped = indeterminate ? undefined : Math.max(0, Math.min(100, Math.round(value)));
    return (_jsx("div", { className: "progress", role: "progressbar", "aria-label": label, "aria-valuemin": indeterminate ? undefined : 0, "aria-valuemax": indeterminate ? undefined : 100, "aria-valuenow": clamped, children: _jsx("div", { className: indeterminate ? 'progress__bar progress__bar--indeterminate' : 'progress__bar', style: { width: indeterminate ? undefined : `${clamped}%` } }) }));
}
export function Spinner({ label }) {
    return (_jsx("span", { role: "status", "aria-live": "polite", "aria-label": label ?? 'Loading', style: { display: 'inline-flex' }, children: _jsx("span", { className: "spinner", "aria-hidden": "true" }) }));
}
//# sourceMappingURL=ProgressBar.js.map