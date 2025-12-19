import { useMemo, useRef } from 'react';
import type { Message } from '../types';
import {
  WhiteboardState,
  createEmptyWhiteboard,
  isWhiteboardDiff,
  parseWhiteboardDiff,
  applyDiff,
  renderWhiteboard,
} from '../utils/whiteboardDiff';

// Agent name for the whiteboard
const WHITEBOARD_AGENT = '화이트보드';

interface WhiteboardMessageInfo {
  // The rendered whiteboard content to display instead of the diff
  renderedContent: string;
  // Whether this is a whiteboard message
  isWhiteboardMessage: boolean;
}

/**
 * Hook to process whiteboard diffs from messages and provide rendered content
 * Returns a stable reference when content hasn't changed to prevent unnecessary re-renders
 *
 * @param messages - Array of chat messages
 * @returns Map of message IDs to their rendered whiteboard content
 */
export function useWhiteboard(messages: Message[]): Map<number | string, WhiteboardMessageInfo> {
  const prevMapRef = useRef<Map<number | string, WhiteboardMessageInfo>>(new Map());

  return useMemo(() => {
    const messageInfoMap = new Map<number | string, WhiteboardMessageInfo>();
    let whiteboardState: WhiteboardState = createEmptyWhiteboard();

    for (const message of messages) {
      // Check if this is a message from the whiteboard agent
      const isFromWhiteboard = message.agent_name === WHITEBOARD_AGENT;

      if (!isFromWhiteboard || !message.content) {
        continue;
      }

      // Check if the content contains a whiteboard diff
      if (isWhiteboardDiff(message.content)) {
        // Parse and apply the diff
        const operations = parseWhiteboardDiff(message.content);

        if (operations.length > 0) {
          whiteboardState = applyDiff(whiteboardState, operations);
        }

        // Store the rendered content for this message
        const rendered = renderWhiteboard(whiteboardState);
        messageInfoMap.set(message.id, {
          renderedContent: rendered,
          isWhiteboardMessage: true,
        });
      } else {
        // This is a whiteboard message but not a diff format
        // Might be the old full-content format - just show as-is
        messageInfoMap.set(message.id, {
          renderedContent: message.content,
          isWhiteboardMessage: true,
        });
      }
    }

    // Return previous map if content is identical to prevent re-renders
    const prevMap = prevMapRef.current;
    if (messageInfoMap.size === prevMap.size) {
      let isIdentical = true;
      for (const [key, value] of messageInfoMap) {
        const prevValue = prevMap.get(key);
        if (!prevValue || prevValue.renderedContent !== value.renderedContent) {
          isIdentical = false;
          break;
        }
      }
      if (isIdentical) {
        return prevMap;
      }
    }

    prevMapRef.current = messageInfoMap;
    return messageInfoMap;
  }, [messages]);
}

/**
 * Get the current whiteboard state from messages (final accumulated state)
 */
export function getCurrentWhiteboardState(messages: Message[]): WhiteboardState {
  let state = createEmptyWhiteboard();

  for (const message of messages) {
    if (message.agent_name !== WHITEBOARD_AGENT || !message.content) {
      continue;
    }

    if (isWhiteboardDiff(message.content)) {
      const operations = parseWhiteboardDiff(message.content);
      if (operations.length > 0) {
        state = applyDiff(state, operations);
      }
    }
  }

  return state;
}
