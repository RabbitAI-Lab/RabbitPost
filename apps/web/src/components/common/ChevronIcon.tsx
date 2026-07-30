/**
 * 宽扁的 chevron 折叠箭头（VS Code codicon 风格）。
 * open 时朝下，否则旋转 -90° 朝右。
 */
export default function ChevronIcon({
  open,
  size = 12,
  color = "#8c8c8c",
}: {
  open: boolean;
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{
        flexShrink: 0,
        transition: "transform 0.15s",
        transform: open ? undefined : "rotate(-90deg)",
      }}
    >
      <path
        d="M3.2 5.8 L8 10.6 L12.8 5.8"
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
