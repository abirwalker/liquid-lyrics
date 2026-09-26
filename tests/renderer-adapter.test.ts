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

  const backingResult: LyricsResult = {
    source: 'amll', instrumental: false, lines: [{
      text: "Slittin' my throat (How long?)",
      timing: 'word', startMs: 1000, endMs: 3000, agent: null,
      segments: [
        { text: "Slittin' ", startMs: 1000, endMs: 1800, role: null },
        { text: 'my throat ', startMs: 1800, endMs: 3000, role: null },
        { text: '(How ', startMs: 2400, endMs: 3100, role: 'x-bg' },
        { text: 'long?)', startMs: 3100, endMs: 3900, role: 'x-bg' },
      ],
    }],
  };
  const backingLines = convertToAmllLines(backingResult);
  assert.equal(backingLines.length, 2);
  assert.equal(backingLines[0].isBG, false);
  assert.equal(backingLines[1].isBG, true);
  assert.equal(backingLines[0].words.map((word) => word.word).join(''), "Slittin' my throat ");
  assert.equal(backingLines[1].words.map((word) => word.word).join(''), 'How long?');
  assert.equal(backingLines[1].words[0].startTime, 2400);
  assert.equal(backingLines[1].endTime, 3900);

  const bracketedResult: LyricsResult = { source: 'lrclib', instrumental: false, lines: [
    { text: '(How long?) Slittin my throat', timing: 'line', startMs: 0, endMs: 4000, agent: null,
      segments: [{ text: '(How long?) Slittin my throat', startMs: null, endMs: null, role: null }] },
    { text: 'Slittin my throat (How long?)', timing: 'line', startMs: 5000, endMs: 9000, agent: null,
      segments: [{ text: 'Slittin my throat (How long?)', startMs: null, endMs: null, role: null }] },
  ] };
  const bracketedLines = convertToAmllLines(bracketedResult);
  assert.equal(bracketedLines.length, 4);
  assert.deepEqual(bracketedLines.map((line) => line.isBG), [false, true, false, true]);
  assert.equal(bracketedLines[0].words[0].word, 'Slittin my throat');
  assert.equal(bracketedLines[1].words[0].word, 'How long?');
  assert.ok(bracketedLines[1].words[0].startTime < bracketedLines[0].words[0].startTime);
  assert.equal(bracketedLines[1].endTime, bracketedLines[0].endTime);
  assert.equal(bracketedLines[1].inferredBacking, true);
  assert.equal(bracketedLines[3].words[0].word, 'How long?');
  assert.equal(bracketedLines[3].words[0].startTime, bracketedLines[2].words[0].startTime);
  assert.equal(bracketedLines[3].inferredBacking, true);

  const boundedResult: LyricsResult = { source: 'lrclib', instrumental: false, lines: [
    { text: 'Lead (backing)', timing: 'line', startMs: 1000, endMs: null, agent: null,
      segments: [{ text: 'Lead (backing)', startMs: null, endMs: null, role: null }] },
    { text: 'Next', timing: 'line', startMs: 3000, endMs: null, agent: null,
      segments: [{ text: 'Next', startMs: null, endMs: null, role: null }] },
  ] };
  const boundedLines = convertToAmllLines(boundedResult);
  assert.equal(boundedLines[0].endTime, 3000);
  assert.equal(boundedLines[1].endTime, 3000);

  const interiorBrackets: LyricsResult = { source: 'lrclib', instrumental: false, lines: [
    { text: 'Lead (aside) continues', timing: 'line', startMs: 0, endMs: 3000, agent: null,
      segments: [{ text: 'Lead (aside) continues', startMs: null, endMs: null, role: null }] },
  ] };
  assert.equal(convertToAmllLines(interiorBrackets).length, 1);
  const untaggedWord: LyricsResult = { source: 'lyricsplus', instrumental: false, lines: [
    { text: 'Lead (aside)', timing: 'word', startMs: 0, endMs: 3000, agent: null,
      segments: [{ text: 'Lead ', startMs: 0, endMs: 1500, role: null },
        { text: '(aside)', startMs: 1500, endMs: 3000, role: null }] },
  ] };
  const shortBacking = convertToAmllLines(untaggedWord);
  assert.equal(shortBacking.length, 2);
  assert.equal(shortBacking[1].isBG, true);
  assert.equal(shortBacking[1].words[0].word, 'aside');
  assert.equal(shortBacking[1].words[0].startTime, 1500);

  const sunflower: LyricsResult = { source: 'lyricsplus', instrumental: false, lines: [
    { text: "You're the sunflower (Yeah, yeah)", timing: 'word', startMs: 0, endMs: 4200, agent: null,
      segments: [
        { text: "You're ", startMs: 0, endMs: 800, role: null },
        { text: 'the ', startMs: 800, endMs: 1200, role: null },
        { text: 'sunflower ', startMs: 1200, endMs: 2700, role: null },
        { text: '(Yeah, ', startMs: 2700, endMs: 3400, role: null },
        { text: 'yeah)', startMs: 3400, endMs: 4200, role: null },
      ] },
  ] };
  const sunflowerLines = convertToAmllLines(sunflower);
  assert.equal(sunflowerLines.length, 2);
  assert.equal(sunflowerLines[1].isBG, true);
  assert.deepEqual(sunflowerLines[1].words.map((word) => word.word), ['Yeah, ', 'yeah']);
  assert.equal(sunflowerLines[1].words[0].startTime, 2700);
  assert.equal(sunflowerLines[1].words[1].endTime, 4200);

  const prefixWord: LyricsResult = { source: 'lyricsplus', instrumental: false, lines: [
    { text: '(Oh) lead', timing: 'word', startMs: 0, endMs: 2200, agent: null,
      segments: [{ text: '(Oh) ', startMs: 0, endMs: 800, role: null },
        { text: 'lead', startMs: 800, endMs: 2200, role: null }] },
  ] };
  const prefixLines = convertToAmllLines(prefixWord);
  assert.equal(prefixLines.length, 2);
  assert.ok(prefixLines[1].words[0].startTime < prefixLines[0].words[0].startTime);

  const attachedShortWord: LyricsResult = { source: 'lyricsplus', instrumental: false, lines: [
    { text: 'lead(Oh)', timing: 'word', startMs: 0, endMs: 1200, agent: null,
      segments: [{ text: 'lead(Oh)', startMs: 0, endMs: 1200, role: null }] },
  ] };
  const attachedLines = convertToAmllLines(attachedShortWord);
  assert.equal(attachedLines.length, 2);
  assert.equal(attachedLines[1].isBG, true);
  assert.equal(attachedLines[1].words[0].word, 'Oh');

  const separateBacking: LyricsResult = { source: 'binilyrics', instrumental: false, lines: [
    { text: 'Lead one', timing: 'line', startMs: 14178, endMs: 16311, agent: null,
      segments: [{ text: 'Lead one', startMs: null, endMs: null, role: null }] },
    { text: '(Backing one)', timing: 'line', startMs: 16564, endMs: 18563, agent: null,
      segments: [{ text: '(Backing one)', startMs: null, endMs: null, role: null }] },
    { text: 'Lead two', timing: 'line', startMs: 74219, endMs: 76071, agent: null,
      segments: [{ text: 'Lead two', startMs: null, endMs: null, role: null }] },
    { text: '(Backing two)', timing: 'line', startMs: 76578, endMs: 79276, agent: null,
      segments: [{ text: '(Backing two)', startMs: null, endMs: null, role: null }] },
    { text: 'Next lead', timing: 'line', startMs: 78959, endMs: 80891, agent: null,
      segments: [{ text: 'Next lead', startMs: null, endMs: null, role: null }] },
  ] };
  const separateLines = convertToAmllLines(separateBacking);
  assert.equal(separateLines.length, 5);
  assert.deepEqual(separateLines.map(line => line.isBG), [false, true, false, true, false]);
  assert.equal(separateLines[1].words[0].word, 'Backing one');
  assert.equal(separateLines[1].startTime, 16564);
  assert.equal(separateLines[1].endTime, 18563);
  assert.equal(separateLines[3].words[0].word, 'Backing two');
  assert.equal(separateLines[3].endTime, 79276);
  assert.ok(separateLines[3].endTime > separateLines[4].startTime);

  const separateWord: LyricsResult = { source: 'lyricsplus', instrumental: false, lines: [
    { text: 'Lead', timing: 'word', startMs: 0, endMs: 900, agent: null,
      segments: [{ text: 'Lead', startMs: 0, endMs: 900, role: null }] },
    { text: '(Oh yeah)', timing: 'word', startMs: 1000, endMs: 2200, agent: null,
      segments: [{ text: '(Oh ', startMs: 1000, endMs: 1500, role: null },
        { text: 'yeah)', startMs: 1500, endMs: 2200, role: null }] },
  ] };
  const separateWordLines = convertToAmllLines(separateWord);
  assert.equal(separateWordLines[1].isBG, true);
  assert.deepEqual(separateWordLines[1].words.map(word => word.word), ['Oh ', 'yeah']);
  assert.equal(separateWordLines[1].words[1].endTime, 2200);

  const forwardMatch: LyricsResult = { source: 'binilyrics', instrumental: false, lines: [
    { text: 'Distant thought', timing: 'line', startMs: 0, endMs: 1000, agent: null,
      segments: [{ text: 'Distant thought', startMs: null, endMs: null, role: null }] },
    { text: '(Come closer tonight)', timing: 'line', startMs: 1200, endMs: 1800, agent: null,
      segments: [{ text: '(Come closer tonight)', startMs: null, endMs: null, role: null }] },
    { text: 'Come closer tonight', timing: 'line', startMs: 1600, endMs: 2800, agent: null,
      segments: [{ text: 'Come closer tonight', startMs: null, endMs: null, role: null }] },
  ] };
  const forwardLines = convertToAmllLines(forwardMatch);
  assert.deepEqual(forwardLines.map(line => [line.words[0].word, line.isBG]), [
    ['Distant thought', false], ['Come closer tonight', false], ['Come closer tonight', true],
  ]);
  assert.ok(forwardLines[2].words[0].startTime < forwardLines[1].words[0].startTime,
    'a matching following lead places the backing vocal above it');

  console.log('All AMLL renderer adapter tests passed successfully!');
}

runAdapterTests();
