import { type ReactNode } from 'react';
export interface AccordionItemProps {
    question: string;
    children: ReactNode;
    defaultOpen?: boolean;
}
/** Keyboard-accessible disclosure (WAI-ARIA accordion pattern). */
export declare function AccordionItem({ question, children, defaultOpen }: AccordionItemProps): import("react").JSX.Element;
//# sourceMappingURL=Accordion.d.ts.map