/** 品牌标记：抽象「文本 → 译文」的几何图形，不用字母和表情 */
export default function Mark({ size = 22 }: { size?: number }): React.ReactElement {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="AI 网页翻译">
      <rect className="mark-frame" x="1" y="1" width="22" height="22" rx="6.5" />
      <path className="mark-rule" d="M6.4 9.2h6.2M6.4 12.6h3.6" />
      <path className="mark-caret" d="M13.4 7.4 18 11.8 13.4 16.2" />
    </svg>
  );
}
