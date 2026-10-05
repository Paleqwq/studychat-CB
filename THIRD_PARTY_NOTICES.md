# LibreChat UI reference and attribution

This application is an independent research-chat implementation, not the
official LibreChat application and not a full LibreChat fork.

The chat presentation was adapted with reference to the source of
LibreChat (https://github.com/LibreChat-AI/LibreChat), at commit
f10b1d91f1eee3a2c82d5247bf620351486b7c1b.

Referenced components:

- client/src/components/UnifiedSidebar/constants.ts
- client/src/components/UnifiedSidebar/ExpandedPanel.tsx
- client/src/components/UnifiedSidebar/Sidebar.tsx
- client/src/components/Chat/ChatView.tsx
- client/src/components/Chat/Header.tsx
- client/src/components/Chat/Landing.tsx
- client/src/components/Chat/Input/ChatForm.tsx
- client/src/components/Chat/Input/SendButton.tsx
- client/src/style.css

The adaptation keeps the 52px desktop icon rail and chat header, neutral
surfaces, 24px rounded composer, centered landing composition, and separate
user/assistant message treatments. The sidebar is responsive, and only the
current research conversation is shown. Model menus, files, tools, search,
projects, account settings, message ratings, and new-chat controls are omitted.

All colors have been converted to true grayscale, including states and icons.
The application uses a generic chat icon rather than LibreChat branding.
Authentication, provider adapters, storage, and the independent admin console
remain this application's own implementation.

## LibreChat license

MIT License

Copyright (c) 2026 LibreChat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
