/**
 * The golden line that will become the life timeline.
 * For now it is just the line; roll points will be placed on it later.
 */
export default function TimelineLine() {
  return (
    <div className="timeline" role="img" aria-label="Your life timeline">
      <div className="timeline__glow" />
      <div className="timeline__line" />
    </div>
  );
}
