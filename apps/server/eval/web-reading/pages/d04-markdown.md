# Pagination

Larkspur list endpoints return at most 100 items per page. The default page size is 25.

## Cursors

Each response includes a `next_cursor`. Pass it as `?cursor=` to get the next page. A missing `next_cursor` means you are on the last page.

## Ordering

Items are sorted by `created_at` descending unless you pass `?order=asc`.
