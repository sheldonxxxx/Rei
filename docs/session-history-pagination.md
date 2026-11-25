# Progressive session history

The web client opens `/api/stream?paged=1`. Its initial snapshot contains home chats, chats waiting for the user, and the six most recently updated sessions. Six allow the mention picker to offer five other chats even when the current chat is the newest. Live session, approval, and takeover events continue normally.

The sidebar fetches `/api/sessions?paged=1&agent=<id>`, 30 visible history rows per page. `nextCursor` encodes the last row's update time and ID; pass it as `before` for the next page. Ordering is descending by update time and ID. Home chats and hidden trigger runs (`hideInList`) are excluded unless `triggers=1` is passed; user-facing trigger runs (`hideInList: false`) are listed normally. A selected hidden trigger run is still shown when opened directly. The sidebar requests another page within 240 pixels of the bottom. Loading uses a shimmering skeleton, eased expansion/collapse, and a short row entrance; reduced motion disables these animations. An error shows a Retry action. There is no Load more button.

Pages merge by session ID. Newer streamed records win over older responses, deleted IDs cannot be resurrected by an in-flight response, and a fresh stream snapshot invalidates previous requests and pagination cursors. Switching agents cancels the previous pagination context. A session that changes during paging moves to the top via the live stream; existing page rows are deduplicated.

Opening a chat fetches `/api/sessions/:id/related` for its metadata, parent, direct children, source branch, and descendant branches. Related metadata does not automatically add older rows to sidebar history. Permission labels use `/api/sessions/:id/summary` to resolve unloaded titles on demand. History search continues to search server-side. The mention picker remains limited to five recently updated other chats.

Legacy requests without `paged=1` retain their complete-list behavior for internal clients and compatibility. The web app does not use those complete-list requests during startup.

Inside a chat, the newest 100 transcript entries come with `GET /api/sessions/:id` and the session stream's snapshot. Older items are paged with `GET /api/sessions/:id/transcript?before=<itemId>`, from the "Load earlier messages" control at the top of the chat. See [Conversation View](conversation-view.md).
