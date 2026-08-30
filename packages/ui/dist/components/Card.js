import { jsx as _jsx } from "react/jsx-runtime";
export function Card({ className, children, ...rest }) {
    return (_jsx("div", { className: className ? `card ${className}` : 'card', ...rest, children: children }));
}
export function Badge({ tone = 'default', className, children, ...rest }) {
    const cls = tone === 'default' ? 'badge' : `badge badge--${tone}`;
    return (_jsx("span", { className: className ? `${cls} ${className}` : cls, ...rest, children: children }));
}
//# sourceMappingURL=Card.js.map