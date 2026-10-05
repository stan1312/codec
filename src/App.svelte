<script>
  import { onMount } from "svelte";
  import { throttle } from "underscore";
  import LocalMediaInput from "./components/LocalMediaInput.svelte";
  import Topbar from "./components/topbar/Topbar.svelte";
  import Tooltip from "./components/Tooltip.svelte";
  import Modules from "./components/modules/Modules.svelte";
  import FilterPanel from "./components/modules/FilterPanel.svelte";
  import IngestPanel from "./components/IngestPanel.svelte";
  import {
    media_store,
    events_store,
    ui_store,
    filter_toggles,
    platform_config_store,
    trajectories_store,
    sheet_refresh,
  } from "./stores/store";
  import { parseTrajectoryRows } from "./lib/geo";
  import { cfgGet } from "./lib/columns";
  import { resolveOffset } from "./lib/syncEdit";

  const mouse_xy = { x: 0, y: 0 };
  const handleMouseMove = throttle((event) => {
    mouse_xy.x = event.clientX;
    mouse_xy.y = event.clientY;
  }, 5);

  let width_mod_grid = Math.floor(document.body.clientWidth / 10) * 10;
  let height_mod_grid = Math.floor(document.body.clientHeight / 10) * 10;

  const handleWindowResize = throttle(() => {
    width_mod_grid = Math.floor(document.body.clientWidth / 10) * 10;
    height_mod_grid = Math.floor(document.body.clientHeight / 10) * 10;
  }, 500);

  // ---- reading the sheet (one call, see functions/sheet-all.js) ----
  // Google allows 60 reads/minute for the whole platform: poll every 20 s,
  // not while the tab is hidden, and back off when Google says "quota".
  const BASE_INTERVAL = 20000;
  let poll_delay = BASE_INTERVAL;
  let poll_timer = null;
  let refresh_timer = null;

  function schedule_poll(delay = poll_delay) {
    clearTimeout(poll_timer);
    poll_timer = setTimeout(async () => {
      if (!document.hidden) {
        try {
          await fetch_google_sheet_data();
          poll_delay = BASE_INTERVAL;
        } catch (e) {
          poll_delay = Math.min(poll_delay * 2, 120000);
          console.log("sheet refresh failed, next try in", poll_delay / 1000, "s", e);
        }
      }
      schedule_poll();
    }, delay);
  }

  onMount(() => {
    schedule_poll();
    // re-read soon after the platform wrote to the sheet (grouped)
    let first = true;
    const unsub = sheet_refresh.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      clearTimeout(refresh_timer);
      refresh_timer = setTimeout(() => schedule_poll(0), 1500);
    });
    const on_visible = () => {
      if (!document.hidden) schedule_poll(500);
    };
    document.addEventListener("visibilitychange", on_visible);
    return () => {
      clearTimeout(poll_timer);
      clearTimeout(refresh_timer);
      unsub();
      document.removeEventListener("visibilitychange", on_visible);
    };
  });

  async function fetch_google_sheet_data(attempt = 0) {
    const res = await fetch(`/.netlify/functions/sheet-all`);
    if (!res.ok) {
      // first load: wait and retry a few times instead of showing an error
      if (attempt < 4 && $platform_config_store["Title of tab with media assets"] === undefined) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        return fetch_google_sheet_data(attempt + 1);
      }
      throw new Error(`lecture du sheet impossible (${res.status})`);
    }
    const data = await res.json();
    if (JSON.stringify($platform_config_store) !== JSON.stringify(data.config)) {
      $platform_config_store = data.config;
    }
    if (data.media && data.media.length) process_video_sheet_response(data.media);
    if (data.events && data.events.length) process_event_sheet_response(data.events);
    const trajectories = parseTrajectoryRows(data.trajectories || []);
    if (JSON.stringify($trajectories_store) !== JSON.stringify(trajectories)) {
      $trajectories_store = trajectories;
    }
  }

  function process_event_sheet_response(rows) {
    // first row of table is column names
    const column_names = rows[0].map((col_name) => col_name.toLowerCase());

    // create array to feed data as being processed
    const events = [];

    // for every row (skipping the first row of column names)
    rows.slice(1).forEach((row, i) => {
      // create a video object
      const event = {};
      // for each column in row
      row.forEach((col_value, i) => {
        // assign the new object the column value under the correct key
        event[column_names[i]] = col_value;
      });

      // date time string to datetime object
      event.start_date_time = localtoUTCdatetimeobj(
        new Date(event["datetime (yyyy-mm-dd hh:mm:ss)"]),
      );
      // create 10 second block for each event
      event.end_date_time = new Date(event.start_date_time.getTime() + 10000);
      // event.className = "case" + event.case
      event.start = event.start_date_time;
      event.end = event.end_date_time;

      const id = i + " event " + event.event;
      event.id = id;
      event.description = event.event;

      // add video object to data array
      events.push(event);
    });
    if (JSON.stringify($events_store) !== JSON.stringify(events)) {
      $events_store = events;
    }
  }

  function process_video_sheet_response(rows) {
    // first row of table is column names
    const column_names = rows[0];
    // create array to feed data as being processed
    const new_videos = {};

    // for every row (skipping the first row of column names)
    rows.slice(1).forEach((row, r) => {
      try {
        // create a video object
        const video = {};
        // for each column in row
        row.forEach((col_value, i) => {
          // assign the new object the column value under the correct key

          // if the col value a string boolean
          if (col_value === "TRUE" || col_value === "FALSE") {
            // transform string boolean to actual boolean
            video[column_names[i]] = col_value === "TRUE";
            // if boolean not already in filter_toggles (only need to do once on first row)
            // and checkig if already in there prevents from re-adding + resetting to false
            // at every sheet fetch
            if (
              (r === 0 || r === 1) &&
              !Object.keys($filter_toggles).includes(column_names[i])
            ) {
              $filter_toggles[column_names[i]] = false;
            }
          } else {
            video[column_names[i]] = col_value;
          }
        });

        // properties for map
        if (
          video[$platform_config_store["Title of column used for latitude"]] &&
          video[$platform_config_store["Title of column used for longitude"]]
        ) {
          video.lat = parseFloat(
            video[$platform_config_store["Title of column used for latitude"]],
          );
          video.long = parseFloat(
            video[$platform_config_store["Title of column used for longitude"]],
          );
        }

        // properties for view cones (optional columns)
        const num_col = (key) => {
          const col = cfgGet($platform_config_store, key);
          if (!col || video[col] === undefined || video[col] === "") return NaN;
          return parseFloat(String(video[col]).replace(",", "."));
        };
        video.bearing = num_col("Title of column used for bearing");
        video.fov = num_col("Title of column used for field of view");
        // optional fine sync adjustment in seconds (added to the chronolocation)
        const offset = num_col("Title of column used for sync offset");
        // an offset just set on the platform wins until the sheet shows it
        video.sync_offset = resolveOffset(video.UAR, Number.isFinite(offset) ? offset : 0);

        // properties for timeline
        video.type = "range";
        video.label = video.UAR;
        video.id = video.UAR;
        video.url =
          video[$platform_config_store["Title of column used for url"]];

        // date time string to datetime object
        if (
          video[
            $platform_config_store["Title of column used for chronolocation"]
          ] &&
          video[$platform_config_store["Title of column used for duration"]]
        ) {
          try {
            video.duration =
              video[
                $platform_config_store["Title of column used for duration"]
              ];
            video.start = localtoUTCdatetimeobj(
              new Date(
                video[
                  $platform_config_store[
                    "Title of column used for chronolocation"
                  ]
                ],
              ),
            );
            const [length_hours, length_minutes, length_seconds] =
              video[
                $platform_config_store["Title of column used for duration"]
              ].split(":");
            video.end_date_time =
              new Date(video.start).getTime() +
              length_hours * 60 * 60 * 1000 +
              length_minutes * 60 * 1000 +
              length_seconds * 1000;
            video.times = [
              {
                starting_time: new Date(video.start).getTime(),
                ending_time: new Date(video.end_date_time).getTime(),
              },
            ];

            video.end = video.end_date_time;

            // chronolocation as written in the sheet, before the fine adjustment
            video.start_raw = new Date(video.start.getTime());
            // fine sync adjustment shifts the whole clip
            if (video.sync_offset) {
              video.start = new Date(video.start.getTime() + video.sync_offset * 1000);
              video.end = new Date(video.end + video.sync_offset * 1000);
              video.end_date_time = video.end;
            }
          } catch {
            console.log("conversion to datetime failed");
            return;
          }
        }

        // // properties for filter
        // Object.entries($filter_toggles).forEach((pair) => {
        //   let [toggle, value] = pair;
        //   if (typeof value === "object") {
        //     let responses = video[toggle];
        //     if (responses == undefined) return;
        //     responses = responses.replaceAll(" ", "");
        //     responses
        //       .split(",")
        //       .filter((response) => {eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
        //         return !["", " ", "NULL"].includes(response);
        //       })
        //       .forEach((response) => {
        //         if (!Object.keys(value).includes(response)) {
        //           value[response] = false;
        //         }
        //       });
        //   }
        //   $filter_toggles[toggle] = value;
        // });

        new_videos[video.UAR] = video;
      } catch (error) {
        console.log(error);
      }
    });

    if (JSON.stringify($media_store) !== JSON.stringify(new_videos)) {
      $media_store = new_videos;
    }
  }

  // Takes datetime object created on local machine with time offset
  // returns datetime object in UTC time when read by same local machine
  function localtoUTCdatetimeobj(datetimeobj) {
    const userTimezoneOffset = datetimeobj.getTimezoneOffset() * 60000;
    return new Date(datetimeobj.getTime() - userTimezoneOffset);
  }
</script>

<svelte:window on:resize={handleWindowResize} />
<svelte:head>
  <title>Investigative Platform</title>
  <meta name="robots" content="noindex nofollow" />
  <html lang="en" />
</svelte:head>

<FilterPanel />
<IngestPanel />
<Tooltip {mouse_xy} />

<main
  on:mousemove={handleMouseMove}
  style="width:{width_mod_grid}px; height:{height_mod_grid}px; left:{$ui_store.filter_in_view
    ? `var(--filtermenu-size)`
    : `0`} "
>
  {#await fetch_google_sheet_data()}
    <div class="modal_container">
      <div class="box modal_content text_level2">
        fetching initial data from the spreadsheet...
      </div>
    </div>
  {:then}
    {#if $platform_config_store["Source of media files"] && $platform_config_store["Source of media files"].includes("local")}
      <LocalMediaInput />
    {/if}
    <Topbar />
    <Modules />
  {:catch error}
    <div class="modal_container">
      <div class="box modal_content text_level2">
        <p>something went wrong, see below for error</p>
        <p>{error.message}</p>
        <p>please reload the page</p>
      </div>
    </div>
  {/await}
</main>
