/**
 * Port of `lib/features/home/home_screen.dart`.
 *
 * Shelves only. `HomeData.stream` is fetched but not rendered here - the same
 * as the Dart `_HomeBody`, which maps `data.shelves` and nothing else. The
 * stream has its own screen at `/feed`.
 */

import { useHome } from "@/api/queries";
import { Shelf } from "@/components/CollectionCard";
import { AsyncView, EmptyState, Page, SkeletonBox } from "@/components/common";

const CARD = 150;
const SHELF_HEIGHT = 206;

export function Home() {
  const home = useHome();

  return (
    <Page>
      <AsyncView
        query={home}
        skeleton={<HomeSkeleton />}
        isEmpty={(d) => d.shelves.length === 0}
        empty={
          <EmptyState
            title="nothing to show right now"
            hint="SoundCloud's editorial shelves are unavailable. Try search, or check back shortly."
          />
        }
      >
        {(data) =>
          data.shelves.map((shelf) => (
            <Shelf key={shelf.title} title={shelf.title} items={shelf.items} size={CARD} />
          ))
        }
      </AsyncView>
    </Page>
  );
}

/** Port of `_HomeSkeleton`: two shelves of four cards. */
function HomeSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1].map((s) => (
        <section key={s} style={{ marginBottom: "var(--section-gap)" }}>
          <SkeletonBox width={180} height={12} />
          <div
            style={{
              display: "flex",
              gap: 20,
              marginTop: "var(--header-gap)",
              height: SHELF_HEIGHT,
              overflow: "hidden",
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ width: CARD }}>
                <SkeletonBox width={CARD} height={CARD} radius="var(--radius-md)" />
                <div style={{ height: 10 }} />
                <SkeletonBox width={110} height={13} />
                <div style={{ height: 6 }} />
                <SkeletonBox width={70} height={11} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
