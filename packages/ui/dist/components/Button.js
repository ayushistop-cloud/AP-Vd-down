import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { forwardRef } from 'react';
/** Primary action button with hover/active/focus/disabled/loading states. */
export const Button = forwardRef(function Button({ variant = 'primary', size = 'md', loading = false, disabled, className, children, ...rest }, ref) {
    const classes = ['btn', `btn--${variant}`];
    if (size !== 'md')
        classes.push(`btn--${size}`);
    if (className)
        classes.push(className);
    return (_jsxs("button", { ref: ref, className: classes.join(' '), disabled: disabled || loading, "aria-busy": loading || undefined, ...rest, children: [loading ? _jsx("span", { className: "spinner", "aria-hidden": "true" }) : null, children] }));
});
//# sourceMappingURL=Button.js.map