import type { ReactNode } from 'react';
export interface BannerProps {
    tone: 'error' | 'success' | 'info' | 'warning';
    title?: string;
    children?: ReactNode;
    actions?: ReactNode;
    /** Set when announcing state changes to assistive technology. */
    politeness?: 'polite' | 'assertive';
}
export declare function Banner({ tone, title, children, actions, politeness }: BannerProps): import("react").JSX.Element;
export declare function EmptyState({ icon, title, children, }: {
    icon?: ReactNode;
    title: string;
    children?: ReactNode;
}): import("react").JSX.Element;
//# sourceMappingURL=Banner.d.ts.map