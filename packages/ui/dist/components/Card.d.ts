import type { HTMLAttributes, ReactNode } from 'react';
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
    children: ReactNode;
}
export declare function Card({ className, children, ...rest }: CardProps): import("react").JSX.Element;
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
    tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
}
export declare function Badge({ tone, className, children, ...rest }: BadgeProps): import("react").JSX.Element;
//# sourceMappingURL=Card.d.ts.map