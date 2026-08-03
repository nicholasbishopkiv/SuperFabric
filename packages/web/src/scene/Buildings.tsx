import { useRoomIds } from "../store";
import { Building } from "./Building";

/**
 * Every building on the floor. Deliberately maps over *ids* only: this component re-renders when a
 * room appears or disappears, and never because one of them moved or gained an agent — each
 * `Building` subscribes to its own row for that.
 */
export function Buildings() {
  const roomIds = useRoomIds();
  return (
    <>
      {roomIds.map((id) => (
        <Building key={id} roomId={id} />
      ))}
    </>
  );
}
