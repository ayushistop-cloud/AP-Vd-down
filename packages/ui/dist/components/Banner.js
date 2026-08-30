import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function Banner({ tone, title, children, actions, politeness = 'polite' }) {
    return (_jsx("div", { className: `banner banner--${tone}`, role: tone === 'error' ? 'alert' : undefined, "aria-live": tone === 'error' ? politeness : undefined, children: _jsxs("div", { className: "banner__body", children: [title ? _jsx("div", { className: "banner__title", children: title }) : null, children ? _jsx("div", { children: children }) : null, actions ? _jsx("div", { className: "banner__actions", children: actions }) : null] }) }));
}
export function EmptyState({ icon, title, children, }) {
    return (_jsxs("div", { style: { textAlign: 'center', padding: 'var(--space-6) var(--space-4)' }, children: [icon ? (_jsx("div", { style: { color: 'var(--text-muted)', marginBottom: 'var(--space-3)', display: 'flex', justifyContent: 'center' }, "aria-hidden": "true", children: icon })) : null, _jsx("div", { className: "t-label", style: { fontSize: '1rem' }, children: title }), children ? _jsx("div", { className: "t-caption", style: { marginTop: 'var(--space-2)' }, children: children }) : null] }));
}
//# sourceMappingURL=Banner.js.map