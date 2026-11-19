/**
 * Small ASCII tabs authored for the import-screen tests (no third-party content).
 */

/** Two bars of evenly spaced eighths (C, Am arpeggios); 16 onsets. */
export const ARPEGGIO = `e|---------0-------|---------0-------|
B|-------1---1-----|-------1---1-----|
G|-----0-------0---|-----2-------2---|
D|---2-----------2-|---2-----------2-|
A|-3---------------|-0---------------|
E|-----------------|-----------------|
`;

/** One bar of eighth-note triplets (12 per bar, two columns apart). */
export const TRIPLETS = `e|-------------------------|
B|-------------------------|
G|-------------------------|
D|-2-2-2-2-2-2-2-2-2-2-2-2-|
A|-------------------------|
E|-------------------------|
`;

/** A header, a staff (lines 4–9), and a stray two-line fragment at lines 11–12 (reported as unparsed). */
export const WITH_JUNK = `Title: Test Riff
Tempo: 100

e|-----------------|
B|-----------------|
G|-----------------|
D|-2-2-2-2-2-2-2-2-|
A|-0-0-0-0-0-0-0-0-|
E|-----------------|

e|---3---3---3---3-|
B|---1---1---1---1-|
`;
