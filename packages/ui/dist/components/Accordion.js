import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useId, useState } from 'react';
/** Keyboard-accessible disclosure (WAI-ARIA accordion pattern). */
export function AccordionItem({ question, children, defaultOpen = false }) {
    const [open, setOpen] = useState(defaultOpen);
    const panelId = useId();
    const triggerId = useId();
    return (_jsxs("div", { className: "accordion-item", children: [_jsxs("button", { id: triggerId, type: "button", className: "accordion-item__trigger", "aria-expanded": open, "aria-controls": panelId, onClick: () => setOpen((v) => !v), children: [question, _jsx("svg", { className: "accordion-item__icon", width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }) })] }), open ? (_jsx("div", { id: panelId, role: "region", "aria-labelledby": triggerId, className: "accordion-item__panel", children: children })) : null] }));
}
//# sourceMappingURL=Accordion.js.map