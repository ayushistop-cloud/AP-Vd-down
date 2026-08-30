import { jsx as _jsx } from "react/jsx-runtime";
import { forwardRef } from 'react';
export const Input = forwardRef(function Input({ className, ...rest }, ref) {
    return _jsx("input", { ref: ref, className: className ? `input ${className}` : 'input', ...rest });
});
//# sourceMappingURL=Input.js.map