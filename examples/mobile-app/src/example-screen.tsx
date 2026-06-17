import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  emitProfileEvent,
  registerProfileCommandTargetHandler,
  useProfileSession,
  useProfileSessionBootstrap,
} from './devtools/profile-session';

const CARDS = [
  'Profile session control',
  'Portable scenario manifests',
  'Stable evidence artifacts',
  'Before and after comparisons',
  'Agent-readable summaries',
];

/**
 * Emits one app-owned profile event for the active example scenario.
 *
 * @param {string} event
 * @param {number} iteration
 * @returns {void}
 */
function mark(event: string, iteration = 1): void {
  emitProfileEvent(event, {
    flowId: 'example-mobile-app',
    iteration,
    owner: 'example-mobile-app',
    route: 'home',
  });
}

/**
 * Neutral Expo screen used to dogfood Agent Scenario Loop contracts.
 *
 * @returns {React.ReactElement}
 */
export function ExampleScreen(): React.ReactElement {
  useProfileSessionBootstrap();

  const insets = useSafeAreaInsets();
  const profileSession = useProfileSession();
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [scrollSettled, setScrollSettled] = useState(false);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const commandIterationRef = useRef(1);
  const ignoredMomentumEndsRef = useRef(0);
  const selectedIterationRef = useRef(1);
  const startupRunKeyRef = useRef<string | null>(null);

  const openCard = useCallback((index: number, iterationOverride?: number) => {
    const card = CARDS[index] ?? CARDS[0];
    const iteration = iterationOverride ?? index + 1;
    mark('card_open_requested', iteration);
    selectedIterationRef.current = iteration;
    setSelectedCard(card);
    requestAnimationFrame(() => {
      mark('card_opened', iteration);
    });
  }, []);

  const closeCard = useCallback(() => {
    const iteration = selectedIterationRef.current;
    mark('card_close_requested', iteration);
    setSelectedCard(null);
    requestAnimationFrame(() => {
      mark('card_dismissed', iteration);
    });
  }, []);

  const runScrollSettle = useCallback((iteration = 1) => {
    setScrollSettled(false);
    mark('feed_scroll_started', iteration);
    ignoredMomentumEndsRef.current += 1;
    scrollViewRef.current?.scrollTo({ animated: true, y: 360 });
    requestAnimationFrame(() => {
      mark('feed_first_content_visible', iteration);
      mark('feed_scroll_settle_requested', iteration);
      mark('feed_scroll_settled', iteration);
      setScrollSettled(true);
    });
  }, []);

  useEffect(() => {
    if (profileSession.runId && profileSession.startedAt) {
      commandIterationRef.current = 1;
    }
  }, [profileSession.runId, profileSession.startedAt]);

  useEffect(() => {
    const startupRunKey = `${profileSession.runId ?? 'unknown'}:${profileSession.startedAt ?? 0}`;
    if (
      !profileSession.active ||
      profileSession.scenario !== 'app-startup' ||
      !profileSession.runId ||
      !profileSession.startedAt ||
      startupRunKeyRef.current === startupRunKey
    ) {
      return;
    }

    startupRunKeyRef.current = startupRunKey;
    mark('app_launch_requested');
    requestAnimationFrame(() => {
      mark('home_ready');
      mark('startup_idle_observed');
      mark('startup_complete');
    });
  }, [
    profileSession.active,
    profileSession.runId,
    profileSession.scenario,
    profileSession.startedAt,
  ]);

  useEffect(() => {
    const unregisterOpen = registerProfileCommandTargetHandler('example-card-1', () => {
      openCard(0, commandIterationRef.current);
    });
    const unregisterClose = registerProfileCommandTargetHandler('close-card', () => {
      closeCard();
      commandIterationRef.current += 1;
    });
    const unregisterScroll = registerProfileCommandTargetHandler('scroll-feed', () => {
      runScrollSettle(commandIterationRef.current);
      commandIterationRef.current += 1;
    });

    return () => {
      unregisterOpen();
      unregisterClose();
      unregisterScroll();
    };
  }, [closeCard, openCard, runScrollSettle]);

  return (
    <View style={styles.root}>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: Math.max(insets.bottom + 120, 144),
            paddingTop: insets.top + 18,
          },
        ]}
        contentInsetAdjustmentBehavior="automatic"
        onScrollBeginDrag={() => {
          setScrollSettled(false);
          mark('feed_scroll_started');
        }}
        onMomentumScrollEnd={() => {
          if (ignoredMomentumEndsRef.current > 0) {
            ignoredMomentumEndsRef.current -= 1;
            return;
          }

          mark('feed_first_content_visible');
          mark('feed_scroll_settle_requested');
          mark('feed_scroll_settled');
          setScrollSettled(true);
        }}
        scrollEventThrottle={16}
      >
        <View style={styles.header}>
          <Text selectable style={styles.eyebrow}>
            agent scenario loop
          </Text>
          <Text selectable style={styles.title} testID="asl-example-title">
            Example Mobile App
          </Text>
          <Text selectable style={styles.subtitle}>
            A neutral app surface for startup, open-close, and scroll-settle evidence.
          </Text>
        </View>

        {CARDS.map((card, index) => (
          <Pressable
            accessibilityRole="button"
            key={card}
            onPress={() => {
              openCard(index);
            }}
            style={styles.card}
          >
            <Text selectable style={styles.cardTitle}>
              {card}
            </Text>
            <Text selectable style={styles.cardBody}>
              Tap to emit an open milestone and show a dismissible detail surface.
            </Text>
          </Pressable>
        ))}

        <Text selectable style={styles.scrollState}>
          {scrollSettled ? 'scroll evidence settled' : 'ready for scroll evidence'}
        </Text>
      </ScrollView>

      {selectedCard ? (
        <View
          style={[
            styles.sheet,
            {
              bottom: Math.max(insets.bottom, 18),
            },
          ]}
        >
          <Text selectable style={styles.sheetTitle}>
            {selectedCard}
          </Text>
          <Text selectable style={styles.sheetBody}>
            This surface is intentionally boring so repeated open-close evidence is stable.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              closeCard();
            }}
            style={styles.closeButton}
          >
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#f7f8fa',
    flex: 1,
  },
  content: {
    gap: 12,
    paddingHorizontal: 16,
  },
  header: {
    borderBottomColor: '#d9dde5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingBottom: 18,
  },
  eyebrow: {
    color: '#4f6b9a',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  title: {
    color: '#151922',
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: '#5b6472',
    fontSize: 15,
    lineHeight: 21,
  },
  card: {
    backgroundColor: '#ffffff',
    borderColor: '#d9dde5',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  cardTitle: {
    color: '#151922',
    fontSize: 17,
    fontWeight: '700',
  },
  cardBody: {
    color: '#5b6472',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  scrollState: {
    color: '#4f6b9a',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  sheet: {
    backgroundColor: '#ffffff',
    borderColor: '#d9dde5',
    borderRadius: 8,
    borderWidth: 1,
    left: 16,
    padding: 16,
    position: 'absolute',
    right: 16,
  },
  sheetTitle: {
    color: '#151922',
    fontSize: 20,
    fontWeight: '800',
  },
  sheetBody: {
    color: '#5b6472',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: '#151922',
    borderRadius: 8,
    marginTop: 14,
    padding: 12,
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
