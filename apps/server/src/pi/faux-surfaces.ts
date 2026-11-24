// Surface scenarios for the faux model (`REI_MODEL_MODE=faux`), so surfaces can be worked on and tested end to end
// without a real model. Each is a `show_surface` call as a model would make it:
//   /demo ui        one surface with every data component (table, chart, map, timeline, gallery, links, progress, checklist)
//   /demo form      a three-step form with field checks, submitted once
//   /demo ui bad    an invalid call (a table row with a key that is no column), then the repaired call
//   /demo live      in a home chat: starts a worker, then shows a progress surface fed by it

export const DEMO_TRIP = {
  title: "Kyoto trip",
  components: [
    { id: "root", component: "Column", children: ["intro", "tabs"] },
    {
      id: "intro",
      component: "Text",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: A2UI formatString interpolation, not a JS template.
      text: { "@call": "formatString", args: { value: "Plan for ${/city}, ${/dates}." } },
    },
    {
      id: "tabs",
      component: "Tabs",
      tabs: [
        { title: "Prices", child: "pricesCol" },
        { title: "Plan", child: "planCol" },
        { title: "More", child: "moreCol" },
      ],
    },
    { id: "pricesCol", component: "Column", children: ["prices", "chart"] },
    {
      id: "prices",
      component: "Table",
      title: "Hotels",
      columns: [
        { key: "name", label: "Hotel" },
        { key: "area", label: "Area" },
        { key: "price", label: "Per night (JPY)", align: "end" },
      ],
      rows: { "@path": "/hotels" },
      caption: "Prices checked today.",
      sortable: true,
      filterable: true,
      pageSize: 5,
    },
    {
      id: "chart",
      component: "Chart",
      variant: "line",
      title: "Temperature",
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      series: [
        { name: "High", values: [18, 19, 17, 16, 18] },
        { name: "Low", values: [9, 10, 8, 7, 9] },
      ],
      unit: "°C",
    },
    { id: "planCol", component: "Column", children: ["timeline", "map"] },
    {
      id: "timeline",
      component: "Timeline",
      title: "Itinerary",
      items: [
        { date: "2026-11-20", time: "09:40", title: "Shinkansen to Kyoto", kind: "train", location: "Tokyo Station" },
        { date: "2026-11-20", time: "13:00", title: "Lunch at Nishiki Market", kind: "meal" },
        {
          date: "2026-11-21",
          time: "08:00",
          title: "Fushimi Inari",
          kind: "activity",
          detail: "Go early to avoid crowds.",
        },
      ],
    },
    {
      id: "map",
      component: "Map",
      title: "Places",
      places: [
        { name: "Fushimi Inari", lat: 34.9671, lon: 135.7727 },
        { name: "Kiyomizu-dera", lat: 34.9949, lon: 135.785 },
      ],
    },
    { id: "moreCol", component: "Column", children: ["links", "progress", "checklist", "ok"] },
    {
      id: "links",
      component: "Links",
      title: "Sources",
      links: [{ url: "https://example.com/kyoto", title: "Kyoto in autumn", site: "example.com" }],
    },
    { id: "progress", component: "Progress", label: "Booking", value: 40, status: "running" },
    {
      id: "checklist",
      component: "Steps",
      variant: "checklist",
      title: "To do",
      items: [
        { title: "Book hotel", status: "done" },
        { title: "Buy rail pass", status: "running" },
        { title: "Reserve dinner", status: "pending" },
      ],
    },
    {
      id: "ok",
      component: "Button",
      child: "okLabel",
      variant: "primary",
      action: { event: { name: "looks_good", context: { city: { "@path": "/city" } } } },
    },
    { id: "okLabel", component: "Text", text: "Looks good" },
  ],
  data: {
    city: "Kyoto",
    dates: "20–22 November",
    hotels: [
      { name: "Gion Inn", area: "Gion", price: 18000 },
      { name: "River House", area: "Pontocho", price: 24000 },
      { name: "Station Stay", area: "Kyoto Station", price: 12000 },
      { name: "Temple View", area: "Higashiyama", price: 21000 },
      { name: "Bamboo Lodge", area: "Arashiyama", price: 16000 },
      { name: "Market Rooms", area: "Nishiki", price: 14000 },
    ],
  },
};

export const DEMO_FORM = {
  title: "Trip details",
  components: [
    {
      id: "root",
      component: "Steps",
      variant: "form",
      title: "Trip details",
      steps: [
        { title: "Who", child: "who" },
        { title: "When", child: "when" },
        { title: "Extras", child: "extras" },
      ],
      submitLabel: "Send",
      action: {
        event: {
          name: "submit_trip",
          context: {
            email: { "@path": "/email" },
            travellers: { "@path": "/travellers" },
            date: { "@path": "/date" },
            rooms: { "@path": "/rooms" },
            breakfast: { "@path": "/breakfast" },
          },
        },
      },
    },
    { id: "who", component: "Column", children: ["email", "travellers"] },
    {
      id: "email",
      component: "TextField",
      label: "Email",
      value: { "@path": "/email" },
      "@checks": [
        { condition: { "@call": "required", args: { value: { "@path": "/email" } } }, message: "Email is required." },
        { condition: { "@call": "email", args: { value: { "@path": "/email" } } }, message: "Enter a valid email." },
      ],
    },
    {
      id: "travellers",
      component: "TextField",
      label: "Travellers",
      variant: "number",
      value: { "@path": "/travellers" },
      "@checks": [
        {
          condition: { "@call": "numeric", args: { value: { "@path": "/travellers" }, min: 1, max: 9 } },
          message: "From 1 to 9 travellers.",
        },
      ],
    },
    { id: "when", component: "Column", children: ["date"] },
    {
      id: "date",
      component: "DateTimeInput",
      label: "Arrival",
      enableDate: true,
      value: { "@path": "/date" },
      "@checks": [
        { condition: { "@call": "required", args: { value: { "@path": "/date" } } }, message: "Pick a date." },
      ],
    },
    { id: "extras", component: "Column", children: ["rooms", "breakfast"] },
    {
      id: "rooms",
      component: "ChoicePicker",
      label: "Room",
      variant: "mutuallyExclusive",
      options: [
        { label: "Single", value: "single" },
        { label: "Double", value: "double" },
        { label: "Twin", value: "twin" },
      ],
      value: { "@path": "/rooms" },
    },
    { id: "breakfast", component: "CheckBox", label: "Breakfast", value: { "@path": "/breakfast" } },
  ],
  data: { email: "", travellers: "2", date: "", rooms: ["double"], breakfast: false },
};

const BAD_TABLE = {
  title: "Prices",
  components: [
    {
      id: "root",
      component: "Table",
      columns: [{ key: "city", label: "City" }],
      rows: [{ city: "Tokyo" }, { city: "Osaka", price: 3 }],
    },
  ],
};

const FIXED_TABLE = {
  title: "Prices",
  components: [
    {
      id: "root",
      component: "Table",
      columns: [
        { key: "city", label: "City" },
        { key: "price", label: "Price", align: "end" },
      ],
      rows: [{ city: "Tokyo" }, { city: "Osaka", price: 3 }],
    },
  ],
};

/** The progress surface `/demo live` binds to a worker: Rei's feed writes /status, /steps, /percent and /summary. */
export const liveSurface = (session: string) => ({
  title: "Research progress",
  components: [
    { id: "root", component: "Column", children: ["bar", "steps", "summary"] },
    {
      id: "bar",
      component: "Progress",
      label: "Research",
      value: { "@path": "/percent" },
      status: { "@path": "/status" },
    },
    { id: "steps", component: "Steps", variant: "checklist", items: { "@path": "/steps" } },
    { id: "summary", component: "Text", text: { "@path": "/summary" } },
  ],
  data: { status: "waiting", steps: [], summary: "" },
  feed: { session },
});

/** The show_surface calls behind `/demo ui`, `/demo form` and `/demo ui bad`. */
export function surfaceDirectives(prompt: string): { name: string; args: Record<string, unknown> }[] {
  if (/\/demo ui bad\b/.test(prompt))
    return [
      { name: "show_surface", args: BAD_TABLE },
      { name: "show_surface", args: FIXED_TABLE },
    ];
  if (/\/demo ui\b/.test(prompt)) return [{ name: "show_surface", args: DEMO_TRIP }];
  if (/\/demo form\b/.test(prompt)) return [{ name: "show_surface", args: DEMO_FORM }];
  return [];
}
