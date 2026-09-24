import assert from 'node:assert/strict';
import { convertToAmllLines } from '../src/renderer/adapter';
import type { LyricsResult } from '../src/types/types';

function runAdapterTests() {
  console.log('Running AMLL renderer adapter tests...');

  // Case 1: Null or empty
  assert.deepEqual(convertToAmllLines(null), []);
  assert.deepEqual(convertToAmllLines({ source: 'test', instrumental: false, lines: [] }), []);

  // Case 2: Instrumental
  assert.deepEqual(
    convertToAmllLines({ source: 'test', instrumental: true, lines: [] }),
    [],
  );

  // Case 3: Word-synced
  const wordResult: LyricsResult = {
    source: 'binilyrics',
    instrumental: false,
    lines: [
      {
        text: 'Did I say something wrong?',
        timing: 'word',
        startMs: 200,
        endMs: 2000,
        agent: null,
        segments: [
          { text: 'Did ', startMs: 200, endMs: 500, role: null },
          { text: 'I ', startMs: 500, endMs: 700, role: null },
          { text: 'say ', startMs: 700, endMs: 1100, role: null },
          { text: 'something ', startMs: 1100, endMs: 1600, role: null },
          { text: 'wrong?', startMs: 1600, endMs: 1950, role: null },
        ],
      },
      {
        text: 'Did you hear me?',
        timing: 'word',
        startMs: 2200,
        endMs: 4000,
        agent: 'vocal-2',
        segments: [
          { text: 'Did ', startMs: 2200, endMs: 2500, role: 'background' },
          { text: 'you ', startMs: 2500, endMs: 2800, role: 'background' },
          { text: 'hear ', startMs: 2800, endMs: 3300, role: 'background' },
          { text: 'me?', startMs: 3300, endMs: 3900, role: 'background' },
        ],
      },
    ],
  };

  const amllWords = convertToAmllLines(wordResult);
  assert.equal(amllWords.length, 2);
  assert.equal(amllWords[0].words.length, 5);
  assert.equal(amllWords[0].words[0].word, 'Did ');
  assert.equal(amllWords[0].words[0].startTime, 200);
  assert.equal(amllWords[0].words[0].endTime, 500);
  assert.equal(amllWords[0].isBG, false);
  assert.equal(amllWords[0].isDuet, false);

  assert.equal(amllWords[1].isBG, true);
  assert.equal(amllWords[1].isDuet, true);
  assert.equal(amllWords[1].words.length, 4);

  // Case 4: Line-synced (LRC)
  const lrcResult: LyricsResult = {
    source: 'lrclib',
    instrumental: false,
    lines: [
      {
        text: 'Hello world again',
        timing: 'line',
        startMs: 1000,
        endMs: null,
        agent: null,
        segments: [{ text: 'Hello world again', startMs: null, endMs: null, role: null }],
      },
      {
        text: 'Next line is here',
        timing: 'line',
        startMs: 4000,
        endMs: null,
        agent: null,
        segments: [{ text: 'Next line is here', startMs: null, endMs: null, role: null }],
      },
    ],
  };

  const amllLrc = convertToAmllLines(lrcResult);
  assert.equal(amllLrc.length, 2);
  // Line 1 should estimate end before Line 2 starts (approx 4000 - 150 = 3850)
  assert.equal(amllLrc[0].startTime, 1000);
  assert.ok(amllLrc[0].endTime >= 3500);
  // Line timing stays line timing; the renderer must not invent word timestamps.
  assert.equal(amllLrc[0].words.length, 1);
  assert.equal(amllLrc[0].words[0].word, 'Hello world again');

  // Case 5: Syllable boundary merging (e.g. "chok" + "in' " -> "chokin' ")
  const syllableResult: LyricsResult = {
    source: 'binilyrics',
    instrumental: false,
    lines: [
      {
        text: "I know you're chokin' on your fears",
        timing: 'word',
        startMs: 27000,
        endMs: 30500,
        agent: null,
        segments: [
          { text: 'I ', startMs: 27000, endMs: 27300, role: null },
          { text: 'know ', startMs: 27300, endMs: 27700, role: null },
          { text: "you're ", startMs: 27700, endMs: 28200, role: null },
          { text: 'chok', startMs: 28200, endMs: 28600, role: null },
          { text: "in' ", startMs: 28600, endMs: 29200, role: null },
          { text: 'on ', startMs: 29200, endMs: 29500, role: null },
          { text: 'your ', startMs: 29500, endMs: 29800, role: null },
          { text: 'fears', startMs: 29800, endMs: 30400, role: null },
        ],
      },
    ],
  };

  const syllableLines = convertToAmllLines(syllableResult);
  assert.equal(syllableLines.length, 1);
  // Adjacent timed segments stay separate so CJK characters and real syllables retain their timing.
  assert.equal(syllableLines[0].words.length, 8);
  assert.equal(syllableLines[0].words[3].word, 'chok');
  assert.equal(syllableLines[0].words[3].startTime, 28200);
  assert.equal(syllableLines[0].words[3].endTime, 28600);

  // Case 6: Real Apple agent values (v1 lead, v2 secondary)
  const agentResult: LyricsResult = {
    source: 'binilyrics',
    instrumental: false,
    lines: [
      {
        text: 'lead line',
        timing: 'line',
        startMs: 1000,
        endMs: null,
        agent: 'v1',
        segments: [{ text: 'lead line', startMs: null, endMs: null, role: null }],
      },
      {
        text: 'duet line',
        timing: 'line',
        startMs: 5000,
        endMs: null,
        agent: 'v2',
        segments: [{ text: 'duet line', startMs: null, endMs: null, role: null }],
      },
    ],
  };
  const amllAgents = convertToAmllLines(agentResult);
  assert.equal(amllAgents.length, 2);
  assert.equal(amllAgents[0].isDuet, false);
  assert.equal(amllAgents[1].isDuet, true);

  // Case 7: Dense line timing must not double-activate (screenshot bug)
  const denseResult: LyricsResult = {
    source: 'lrclib',
    instrumental: false,
    lines: [
      { text: 'one', timing: 'line', startMs: 1000, endMs: null, agent: null,
        segments: [{ text: 'one', startMs: null, endMs: null, role: null }] },
      { text: 'two', timing: 'line', startMs: 1500, endMs: null, agent: null,
        segments: [{ text: 'two', startMs: null, endMs: null, role: null }] },
      { text: 'three', timing: 'line', startMs: 2000, endMs: null, agent: null,
        segments: [{ text: 'three', startMs: null, endMs: null, role: null }] },
    ],
  };
  const amllDense = convertToAmllLines(denseResult);
  assert.equal(amllDense.length, 3);
  assert.ok(amllDense[0].endTime <= amllDense[1].startTime);
  assert.ok(amllDense[1].endTime <= amllDense[2].startTime);

  // Case 8: Plain lyrics get ordered slots, never all at zero
  const plainResult: LyricsResult = {
    source: 'lrclib',
    instrumental: false,
    lines: [
      { text: 'aaa', timing: 'none', startMs: null, endMs: null, agent: null,
        segments: [{ text: 'aaa', startMs: null, endMs: null, role: null }] },
      { text: 'bbb', timing: 'none', startMs: null, endMs: null, agent: null,
        segments: [{ text: 'bbb', startMs: null, endMs: null, role: null }] },
    ],
  };
  const amllPlain = convertToAmllLines(plainResult);
  assert.equal(amllPlain.length, 2);
  assert.ok(amllPlain[0].startTime < amllPlain[1].startTime);
  assert.ok(amllPlain[0].endTime <= amllPlain[1].startTime);

  console.log('All AMLL renderer adapter tests passed successfully!');
}

runAdapterTests();
