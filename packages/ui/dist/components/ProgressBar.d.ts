export interface ProgressBarProps {
    /** 0..100, or undefined for an indeterminate bar. */
    value?: number;
    label: string;
}
export declare function ProgressBar({ value, label }: ProgressBarProps): import("react").JSX.Element;
export declare function Spinner({ label }: {
    label?: string;
}): import("react").JSX.Element;
//# sourceMappingURL=ProgressBar.d.ts.map