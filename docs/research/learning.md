# Learning research: what makes practice fun *and* effective

> Scope: evidence for Riffway's practice, progression and motivation features, mapped to decisions.
> Player: beginner–intermediate, pick player, rock/metal and recognizable songs, wants to play for others ([user-profile](../user-profile.md)).
> Researched 2026-11-19. Many music-practice studies are small (n = 6–20). Treat them as design guidance, not settled science.

## TL;DR

1. **Keep success near 85%.** Learning is fastest when the task is hard but mostly doable. Tempo is Riffway's main difficulty lever. Recommendations aim one tier above comfort.
2. **Go slow, then ramp up, and count clean runs, not repetitions.** Accurate practice predicts next-day retention. Raw repetition count does not. Default speed trainer: start at 70%, add 5% per clean run (≥90%), drop 5% after 2 failed runs (<70%).
3. **Loop by musical section, then join sections together.** Experts start and stop practice at section boundaries. Loops snap to bars and sections.
4. **Fade the help, not the core feedback.** Per-note hit feedback is the game itself. Over time, hide the extras (early/late labels inside the good window, fret numbers on mastered sections).
5. **Spread practice out and let sleep finish the job.** Recheck mastered sections the next day, then at growing intervals. Nudge toward short daily sessions, never long grinds.
6. **Motivate without dark patterns.** Use weekly goals with automatic freezes, never alert the player about a broken streak, give informational badges rather than currencies, and let the player choose what to do.
7. **Rehearse the performance itself.** Stage mode is one take with no assists. "Performance-ready" means 2 Stage runs at ≥90% on different days. *Deferred* (DEC-23): Stage mode and the performance-ready milestone are stretch task T-072, not in this build.

## Findings → features

| # | Finding | Evidence | Riffway feature / decision | Status |
|---|---|---|---|---|
| 1 | Learning is fastest at roughly 85% success. Flow needs challenge matched to skill | [Wilson 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6831579); [Habe 2019](https://www.frontiersin.org/articles/10.3389/fpsyg.2019.00698/full); Rocksmith designer: "always just one step ahead of you" ([Game Developer](https://gamedeveloper.com/business/with-i-guitar-hero-i-in-the-rearview-i-rocksmith-i-just-might-find-its-niche)) | Recommender targets comfort tier +1. Speed trainer holds accuracy in the 70–90% band | Built |
| 2 | Automatic note-thinning (Rocksmith-style dynamic difficulty) adapts the challenge, but players can feel "never great" | [Ubisoft: Adaptive Difficulty](https://news.ubisoft.com/en-us/article/5XfINjoRmVJgBKR8fGt4EM); [Engadget 2011](https://www.engadget.com/2011/10/18/rocksmith-review/); "change as little as possible" ([UT CML](https://cml.music.utexas.edu/online-resources/intelligent-music-practice/10-tips-for-effective-practice)) | **Do not build automatic note-thinning now.** Tabs come at one difficulty, and generated reductions can sound wrong. Tempo is the adaptive lever. Later: a manual per-section "simplify" option (e.g., first note of each beat only), clearly labeled | Later (manual); never (hidden auto) |
| 3 | Slow practice builds speed, but fast playing uses different movements, so mix tempos | [Furuya 2013](https://pmc.ncbi.nlm.nih.gov/articles/PMC4228459/) (practice at ~70% of max doubled max speed); [Jurinić 2026 review](https://pmc.ncbi.nlm.nih.gov/articles/PMC12812707/) | Speed trainer with stepwise ramp (see Parameters). Optional "burst" pass at target tempo every 4th loop | Built (ramp); later (burst) |
| 4 | Accurate practice predicts retention. Time and repetition count do not | [Duke, Simmons & Cash 2009](https://doi.org/10.1177/0022429408328851) ([summary](https://www.structural-learning.com/research-briefings/practise-the-hard-bit)) | Track **clean runs** per section. Progress counts clean runs, not minutes or plays. After 2 failed runs, suggest slowing down instead of pushing on | Built |
| 5 | Experts chunk by musical structure and start and stop at section boundaries | [Chaffin & Imreh 2002](https://musiclab.uconn.edu/wp-content/uploads/sites/290/2013/10/Practicing-Perfection-Chaffin-2002.pdf) | Loops snap to bars and named sections. Section mastery map. "Chain" step that joins two mastered sections into one loop | Built (snap and mastery); later (chain) |
| 6 | Deliberate practice means targeted work on weaknesses with immediate informative feedback. It matters, but it explains only part of the skill differences between players | [Ericsson 1993](https://doi.org/10.1037/0033-295X.100.3.363); [Macnamara 2014](https://pubmed.ncbi.nlm.nih.gov/24986855/) (≈21% of variance in music) | Results screen shows a section heatmap, names the weakest section, and offers a one-click "Loop this". Copy stays modest; no "10,000 hours" claims | Built |
| 7 | Feedback on every attempt helps during practice but can create dependence. Reduced feedback can retain better. Concurrent feedback suits complex tasks | [Winstein & Schmidt 1990, via Reid 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7205416); [Wulf 2010](https://www.frontiersin.org/articles/10.3389/fpsyg.2010.00190/full); [Sigrist 2015](https://doc.rero.ch/record/333015) | Keep per-note hit/miss (it is the task). **Bandwidth labels:** early/late shown only outside the Great window. Detailed timing stats appear on the results screen only. Later: Memory mode fades fret numbers on mastered sections (like Rocksmith's Master Mode, [player reports](https://steamcommunity.com/app/221680/discussions/0/135509124601874146)) | Built (bandwidth); later (Memory mode) |
| 8 | Learner-controlled feedback and autonomy improve learning | [Chiviacowsky & Wulf follow-up 2012](https://www.frontiersin.org/articles/10.3389/fpsyg.2012.00458/full); [OPTIMAL theory 2016](https://pubmed.ncbi.nlm.nih.gov/26833314/) | Every assist (hand-position cues, guide synth, labels, metronome) can be toggled. A "feedback detail" setting (Minimal / Standard / Detailed) | Built |
| 9 | Interleaved practice is worse during the session but better for retention and transfer. Music evidence is promising but small | [Shea & Morgan 1979](https://www.gwern.net/doc/psychology/spaced-repetition/1979-shea.pdf); [Carter & Grahn 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC4989027); [Wulf & Shea 2002](https://www.doi.org/10.3758/BF03196276) (simple-skill results may not carry over to complex skills) | "Mixed practice" rotates 2–3 saved loops every ~3 min. A loop joins the rotation only after its first clean run, so blocked practice comes first, then interleaving | Later |
| 10 | Distributed practice beats massed practice for motor learning. Sleep consolidates speed and accuracy | [Lee & Genovese 1988](https://doi.org/10.1080/02701367.1988.10609373); [Simmons 2011](https://cml.music.utexas.edu/research/skill-learning-and-procedural-memory); [Walker 2002](https://pubmed.ncbi.nlm.nih.gov/12123620/) (+20% speed after sleep) | **Next-day check** for sections mastered today. Spaced review queue (1/3/7/14/30 days). Plateau message: "Sleep on it — this usually improves overnight" | Built (next-day check); later (full queue) |
| 11 | Effective deliberate practice is limited (~1 h/day early on; practice sessions averaged ~80 min; no benefit past 4 h/day). Short, frequent sessions are advised | [Ericsson 1993](https://graphics8.nytimes.com/images/blogs/freakonomics/pdf/DeliberatePractice(PsychologicalReview).pdf); [UT CML tips](https://cml.music.utexas.edu/online-resources/intelligent-music-practice/10-tips-for-effective-practice) | Default daily goal 15 min. Soft break nudge after 45 min of active play. Never lock the player out | Built (goal); later (nudge) |
| 12 | Warm-ups are widely recommended, but trial evidence is thin | [Ottawa systematized review](https://ruor.uottawa.ca/items/dc17ed8f-31fa-43d2-89e6-feb42acf5f54/full) | Optional, skippable 3-min warm-up (tune, then chromatic 1-2-3-4 at 70 BPM). It doubles as an input and latency check. No injury-prevention claims | Later |
| 13 | For skills still being learned, specific learning goals beat outcome goals and "do your best" | [Seijts & Latham 2005](https://wku.edu/cebs/doctorate/documents/readings/seijts_latham_2005_learning_vs_performance_goals.pdf) | Session goals are phrased as process goals ("Get Verse 2 clean at 80%"), not scores. The player picks from 3 suggestions | Built |
| 14 | Games pull players in through autonomy, competence and relatedness. Expected tangible rewards reduce intrinsic motivation; informational positive feedback increases it | [Ryan, Rigby & Przybylski 2006](https://doi.org/10.1007/s11031-006-9051-8); [Deci, Koestner & Ryan 1999](https://pubmed.ncbi.nlm.nih.gov/10589297/) (positive feedback d = +0.33; expected tangible rewards undermine motivation) | Achievements are informational milestones (first clean full run, performance-ready, repertoire count). **Never build:** currencies, loot, XP for minutes, songs locked behind progress | Built (clean runs, repertoire count); deferred (performance-ready: DEC-23, T-072) |
| 15 | Streaks motivate through loss aversion. Highlighting a broken streak lowers persistence; repair options soften this. One missed day doesn't stop habit formation | [Duolingo](https://blog.duolingo.com/how-duolingo-streak-builds-habit); [Barasch & Silverman 2022](https://knowledge.insead.edu/marketing/consumer-streaks-are-motivating-key-keeping-them-alive); [Lally 2010](https://doi.org/10.1002/ejsp.674); "playing by appointment" dark pattern ([Zagal 2013](https://gup.ub.gu.se/file/101018)) | **Weekly** streak with automatic freezes and silent misses (see Parameters). **Never build:** daily-reset streaks, broken-streak alerts, guilt notifications | Built |
| 16 | Simulated performance produces realistic anxiety. Training under mild pressure prevents choking. Psychological interventions for performance anxiety have some, mostly small-study, support | [Williamon 2014](https://www.frontiersin.org/articles/10.3389/fpsyg.2014.00025/full); [Oudejans & Pijpers 2009](https://doi.org/10.1080/17470210802557702); [Bakhtiari 2025 review](https://pmc.ncbi.nlm.nih.gov/articles/PMC12062091/) | **Stage mode**: one take, no pause, loop or slowdown, assists hidden. Feeds "performance-ready". Later: crowd ambience, take recording, setlists | Deferred (Stage: DEC-23, T-072); later (ambience, recording) |
| 17 | Games keep practice sessions going: practice modes never fail you, offer slowdown and section loops, and have a wait-for-correct-note mode. Rhythm-game controller skills transfer little to a real instrument | [Guitar Hero II](https://en.wikipedia.org/wiki/Guitar_Hero_II) (section practice, 4 speeds, never stops); [Melodics](https://support.melodics.com/en/articles/6777027-practice-mode) (Auto BPM +10, Wait mode); [Rocksmith+ Note by Note](https://news.ubisoft.com/en-us/article/5XfINjoRmVJgBKR8fGt4EM); [Peppler 2011](https://scholarworks.iu.edu/dspace/bitstream/handle/2022/14637/2011_Peppler_Nirvana_Effect.pdf?sequence=1) | No song ever stops on errors. Wait mode (notes hold until played correctly) for first learning. Real-guitar input is core, never a controller | Built (no-fail); later (Wait mode: DEC-23, T-074) |

**Status column.** "Built" means it is in this build; "Later" items are candidates; "Deferred" items were
planned for this iteration and moved to the stretch list by DEC-23 (Stage mode and performance-ready
→ T-072, Memory mode → T-073, Wait mode → T-074, mixed practice → T-075, spaced review queue → T-076;
the next-day check is built). See `TASKS.md` § Stretch tasks.

## Key findings in detail

### 1. Aim for ~85% success (rows 1, 2)
Wilson et al. derive that learning is fastest when training accuracy is about 85%. They proved this for simple learning models only and do not claim it applies directly to complex skills, so treat the number as a target band, not a law ([Wilson 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6831579)). Rocksmith keeps players "one step ahead" by adding or removing notes in real time ([Ubisoft](https://news.ubisoft.com/en-us/article/5XfINjoRmVJgBKR8fGt4EM)). Critics said the original left them in "a perpetual state of work… only ever good enough, never great" ([Engadget](https://www.engadget.com/2011/10/18/rocksmith-review/)). Riffway keeps the arrangement intact and adapts tempo instead, so "100% speed, full notes" stays a clear and reachable goal.

### 2. Slow-to-fast with clean runs (rows 3, 4)
In Furuya et al., novices practicing at about 70% of their top speed roughly doubled their maximum speed, and the gain held two months later (n = 12, so small) ([Furuya 2013](https://pmc.ncbi.nlm.nih.gov/articles/PMC4228459/)). But pianists "do not simply perform the same motions faster" at fast tempos. Short segments that alternate slow and fast reached target speed in fewer trials ([Jurinić 2026](https://pmc.ncbi.nlm.nih.gov/articles/PMC12812707/)). Among advanced pianists, next-day performance tracked the share of error-free run-throughs (r ≈ .71), not practice time or repetitions ([Duke 2009](https://doi.org/10.1177/0022429408328851)). So the speed trainer only advances on clean runs and adds occasional at-tempo bursts. No study sets a step size. Products use +10 BPM ([Melodics](https://support.melodics.com/en/articles/6777027-practice-mode)) or 5% steps (Yousician). +5% is a reasoned default.

### 3. Loop by sections, then chain them (row 5)
A concert pianist's practice segments started and stopped far more often at section boundaries. Her memory of the piece was organized by sections, and hesitations clustered at section ends ([Chaffin & Imreh 2002](https://musiclab.uconn.edu/wp-content/uploads/sites/290/2013/10/Practicing-Perfection-Chaffin-2002.pdf)). Riffway's loop UI should therefore offer named sections first, with bar-level fine-tuning. Mastery is tracked per section. Once two neighboring sections are mastered, the trainer suggests joining them, which fixes the "can play each part but not the transition" problem.

### 4. Feedback: always-on hits, fading extras (rows 7, 8)
The guidance hypothesis holds that feedback on every trial can make learners dependent on it. Winstein & Schmidt found 50% KR (knowledge of results) retained better than 100% ([via Reid 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7205416)). The evidence is mixed, though. Frequent feedback that directs attention to the movement's effect, not the body, helped learning ([Wulf 2010](https://www.frontiersin.org/articles/10.3389/fpsyg.2010.00190/full)), and concurrent feedback is more useful for complex tasks ([Sigrist 2015](https://doc.rero.ch/record/333015)). Riffway's highway is concurrent and focused on the sound and the notes, so it stays. What fades: early/late labels inside the good window (bandwidth feedback), detailed stats moved to the results screen (terminal feedback), and, later, fret numbers on mastered sections (retrieval practice). The player can always choose the detail level, which supports autonomy ([OPTIMAL](https://pubmed.ncbi.nlm.nih.gov/26833314/)).

### 5. Spacing and sleep (rows 10, 11)
A meta-analysis of motor studies found distributed practice better for both acquisition and retention ([Lee & Genovese 1988](https://doi.org/10.1080/02701367.1988.10609373)). Sleep after practice raised sequence-tapping speed about 20% with no loss of accuracy ([Walker 2002](https://pubmed.ncbi.nlm.nih.gov/12123620/)). In musicians, a 24 h gap that included sleep gave the best accuracy gains ([Simmons 2011](https://cml.music.utexas.edu/research/skill-learning-and-procedural-memory)). Elite violinists practiced in sessions averaging about 80 minutes, and training studies show no benefit beyond 4 h a day ([Ericsson 1993](https://graphics8.nytimes.com/images/blogs/freakonomics/pdf/DeliberatePractice(PsychologicalReview).pdf)). Riffway should praise "come back tomorrow" over "one more hour". The next-day check is a cheap first step. The review intervals (1/3/7/14/30) borrow from verbal spaced repetition and are not validated for guitar.

### 6. Motivation without dark patterns (rows 13–15)
Self-determination theory explains why games pull people in: autonomy, competence and relatedness ([Ryan 2006](https://doi.org/10.1007/s11031-006-9051-8)). Expected, tangible rewards reduce intrinsic motivation, while informational praise increases it ([Deci 1999](https://pubmed.ncbi.nlm.nih.gov/10589297/)). Streaks work through loss aversion ([Duolingo](https://blog.duolingo.com/how-duolingo-streak-builds-habit)). Highlighting a broken streak reduces persistence, and the authors recommend weekly streaks, repair options and no break alerts ([Barasch & Silverman](https://knowledge.insead.edu/marketing/consumer-streaks-are-motivating-key-keeping-them-alive)). A single missed day does not derail habit formation ([Lally 2010](https://doi.org/10.1002/ejsp.674)). A daily streak that resets acts like the "withering crops" in Zagal's "playing by appointment" dark pattern ([Zagal 2013](https://gup.ub.gu.se/file/101018)). Goals stay process-focused while the player is still learning a skill ([Seijts & Latham 2005](https://wku.edu/cebs/doctorate/documents/readings/seijts_latham_2005_learning_vs_performance_goals.pdf)).

### 7. Playing for others (row 16)
This player's goal is to play for people. Practicing under mild pressure kept experts from choking in later pressure tests ([Oudejans & Pijpers 2009](https://doi.org/10.1080/17470210802557702)). Simulated recitals and auditions produced anxiety and heart-rate patterns close to real ones ([Williamon 2014](https://www.frontiersin.org/articles/10.3389/fpsyg.2014.00025/full)). Stage mode supplies that pressure in small doses: one take, nothing hidden, no restarts. A run on a later day confirms the song survives a cold start, which is what playing for friends requires. Riffway will not offer therapy-style content. Evidence for those interventions is mostly from small studies ([Bakhtiari 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12062091/)).

### 8. Interleaving, later (row 9)
Random practice performs worse during acquisition but better at retention and transfer ([Shea & Morgan 1979](https://www.gwern.net/doc/psychology/spaced-repetition/1979-shea.pdf)). Clarinetists alternating pieces in 3-minute blocks rated it more useful and showed some retention advantage, though not significant overall ([Carter & Grahn 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC4989027)). Results from simple skills may not transfer to complex ones ([Wulf & Shea 2002](https://www.doi.org/10.3758/BF03196276)), so Mixed practice is opt-in and only uses loops the player can already play cleanly.

## Concrete parameters (defaults; all user-adjustable)

**Speed trainer**
- Start: **70%** of the section's tempo. If the section is rated ≥2 tiers above the player's comfort tier, start at **60%**. Floor 40%.
- **Clean run:** ≥**90%** of notes judged Good or better with the correct pitch, and no more than 2 misses in a row.
- After a clean run: **+5%**. **Failed run:** <70%. After **2 failed runs in a row**: **−5%** and the message "Slow down a notch". Runs from 70% to <90% hold the tempo.
- Cap **100%**. Optional overspeed to 110% after mastery, off by default.
- **Section mastered:** 2 clean runs at 100% in one session. **Locked in:** passes the next-day check.
- Burst (later): every 4th pass is played at 100%, but neither its result nor any failure changes the ramp.

**Loops**
- Snap to section markers, then bars. Minimum 1 bar; suggested 2–8 bars.
- **Pre-roll: 1 bar** (guide audio of the previous bar plus click). 2 bars when tempo is below 60%. Full count-in on the first pass only. No gap between passes.

**Sessions and goals**
- Daily goal **15 min** of active play (choices: 5, 10, 15, 30, 45). One "practice day" = ≥5 min.
- Session start offers 3 process goals: weakest section, the next-day check, and one stretch song.
- Break nudge after **45 min** of continuous play. Plateau nudge after **6** passes with no accuracy gain: "Good place to stop — this usually improves after sleep."

**Streaks (weekly, forgiving)**
- Target **4 practice days per week** (adjustable 2–7). The streak counts consecutive weeks that hit the target.
- **Freeze:** earn 1 for every 2 completed weeks, hold at most **2**, applied automatically to a missed week.
- **Grace:** a missed week without a freeze can be repaired by practicing **2 extra days** the next week.
- Never show a "streak lost" alert. Show "best streak" alongside the current one. Riffway is local, so there are no notifications.

**Feedback fade**
- Early/late text only when |Δt| is beyond the Great window. Per-note gems always light up.
- Results screen: timing histogram, section heatmap, weakest-section shortcut.
- Memory mode (later): on a mastered section, fret-number opacity drops 25% per clean run, down to gems only. Numbers return for a phrase after 2 misses in it. Hand-position cues fade the same way.

**Recommendations**
- **Comfort tier** = highest tier with ≥85% accuracy at 100% speed on ≥2 songs; one such song at a tier already lifts it to the tier below, so a strong run on a harder song counts at once.
- Each card is labelled by its tier relative to comfort (stretch = +1, reach = +2 or more, comfort = at or below), so the label always matches its reason.
- Mix: **60% stretch** (comfort +1), **30% comfort** (repertoire and review), **10% reach** (comfort +2, suggested as single sections).
- Expected first-run accuracy at 70% speed for a stretch song: about 80–85%.

**Milestones**
- **Performance-ready** (deferred, T-072): 2 Stage runs at 100% speed with ≥90% accuracy, on different days.
- Spaced review (later): mastered sections return after 1, 3, 7, 14 and 30 days. Pass at ≥90% to advance. On a miss, reset to 1 day and resume the speed trainer at 85%.

## Sources

- Bakhtiari et al. (2025). Coping strategies for music performance anxiety: systematic review. *Front. Psychol.* https://pmc.ncbi.nlm.nih.gov/articles/PMC12062091/
- Barasch & Silverman (2022). On or off track: (broken) streaks. *J. Consumer Research*, via INSEAD Knowledge. https://knowledge.insead.edu/marketing/consumer-streaks-are-motivating-key-keeping-them-alive
- Carter & Grahn (2016). Blocked vs interleaved practice in clarinetists. *Front. Psychol.* https://pmc.ncbi.nlm.nih.gov/articles/PMC4989027
- Chaffin & Imreh (2002). Practicing perfection. *Psychological Science.* https://musiclab.uconn.edu/wp-content/uploads/sites/290/2013/10/Practicing-Perfection-Chaffin-2002.pdf
- Chiviacowsky, Wulf et al. (2012). Self-controlled feedback follow-up. *Front. Psychol.* https://www.frontiersin.org/articles/10.3389/fpsyg.2012.00458/full
- Deci, Koestner & Ryan (1999). Extrinsic rewards and intrinsic motivation meta-analysis. *Psychol. Bull.* https://pubmed.ncbi.nlm.nih.gov/10589297/
- Duke, Simmons & Cash (2009). It's not how much; it's how. *JRME.* https://doi.org/10.1177/0022429408328851 (summary: https://www.structural-learning.com/research-briefings/practise-the-hard-bit)
- Duolingo (n.d.). How the streak builds habit. https://blog.duolingo.com/how-duolingo-streak-builds-habit
- Engadget (2011). Rocksmith review. https://www.engadget.com/2011/10/18/rocksmith-review/
- Ericsson, Krampe & Tesch-Römer (1993). Deliberate practice. *Psychol. Review.* https://doi.org/10.1037/0033-295X.100.3.363 (PDF: https://graphics8.nytimes.com/images/blogs/freakonomics/pdf/DeliberatePractice(PsychologicalReview).pdf)
- Furuya, Nakamura & Nagata (2013). Transfer of piano practice in fast performance. *BMC Neurosci.* https://pmc.ncbi.nlm.nih.gov/articles/PMC4228459/
- Game Developer (2013). Rocksmith 2014 interview with Paul Cross. https://gamedeveloper.com/business/with-i-guitar-hero-i-in-the-rearview-i-rocksmith-i-just-might-find-its-niche
- Guitar Hero II (Wikipedia; practice mode). https://en.wikipedia.org/wiki/Guitar_Hero_II
- Habe, Biasutti & Kajtna (2019). Flow in musicians and athletes. *Front. Psychol.* https://www.frontiersin.org/articles/10.3389/fpsyg.2019.00698/full
- Jurinić et al. (2026). Biomechanics of piano playing: systematic review. *Front. Psychol.* https://pmc.ncbi.nlm.nih.gov/articles/PMC12812707/
- Lally et al. (2010). How are habits formed. *Eur. J. Soc. Psychol.* https://doi.org/10.1002/ejsp.674
- Lee & Genovese (1988). Distribution of practice in motor skill acquisition. *RQES.* https://doi.org/10.1080/02701367.1988.10609373
- Macnamara, Hambrick & Oswald (2014). Deliberate practice meta-analysis. *Psychol. Sci.* https://pubmed.ncbi.nlm.nih.gov/24986855/
- Melodics: Practice Mode, https://support.melodics.com/en/articles/6777027-practice-mode; How it works, https://melodics.com/how-it-works
- Oudejans & Pijpers (2009). Training with anxiety. *QJEP.* https://doi.org/10.1080/17470210802557702
- Peppler et al. (2011). The Nirvana Effect. *Int. J. Learning and Media.* https://scholarworks.iu.edu/dspace/bitstream/handle/2022/14637/2011_Peppler_Nirvana_Effect.pdf?sequence=1
- Reid & Swafford (2020), summarizing Winstein & Schmidt (1990). *Front. Psychol.* https://pmc.ncbi.nlm.nih.gov/articles/PMC7205416
- Rocksmith 2014 Master Mode (player reports, Steam). https://steamcommunity.com/app/221680/discussions/0/135509124601874146
- Ryan, Rigby & Przybylski (2006). Motivational pull of video games. *Motiv. Emot.* https://doi.org/10.1007/s11031-006-9051-8
- Seijts & Latham (2005). Learning vs performance goals. *Acad. Mgmt. Executive.* https://wku.edu/cebs/doctorate/documents/readings/seijts_latham_2005_learning_vs_performance_goals.pdf
- Shea & Morgan (1979). Contextual interference. *JEP: HLM.* https://www.gwern.net/doc/psychology/spaced-repetition/1979-shea.pdf
- Sigrist et al. (2015). Concurrent multimodal feedback, complex task. *Exp. Brain Res.* https://doc.rero.ch/record/333015
- Simmons (2011). Distributed practice and consolidation in musicians. *JRME*; listed at UT CML. https://cml.music.utexas.edu/research/skill-learning-and-procedural-memory
- Ubisoft (2022). Rocksmith+ Accessibility Spotlight. https://news.ubisoft.com/en-us/article/5XfINjoRmVJgBKR8fGt4EM
- University of Ottawa (thesis). Warm-ups for musicians: systematized review. https://ruor.uottawa.ca/items/dc17ed8f-31fa-43d2-89e6-feb42acf5f54/full
- UT Center for Music Learning. Tips for effective practice. https://cml.music.utexas.edu/online-resources/intelligent-music-practice/10-tips-for-effective-practice
- Walker et al. (2002). Practice with sleep makes perfect. *Neuron.* https://pubmed.ncbi.nlm.nih.gov/12123620/
- Williamon, Aufegger & Eiholzer (2014). Simulated performance. *Front. Psychol.* https://www.frontiersin.org/articles/10.3389/fpsyg.2014.00025/full
- Wilson et al. (2019). The Eighty Five Percent Rule. *Nat. Commun.* https://pmc.ncbi.nlm.nih.gov/articles/PMC6831579
- Wulf et al. (2010). Frequent external-focus feedback. *Front. Psychol.* https://www.frontiersin.org/articles/10.3389/fpsyg.2010.00190/full
- Wulf & Lewthwaite (2016). OPTIMAL theory. *Psychon. Bull. Rev.* https://pubmed.ncbi.nlm.nih.gov/26833314/
- Wulf & Shea (2002). Simple-skill principles don't generalize. *Psychon. Bull. Rev.* https://www.doi.org/10.3758/BF03196276
- Zagal, Björk & Lewis (2013). Dark patterns in the design of games. *FDG.* https://gup.ub.gu.se/file/101018

**Not verified, so left out or hedged:** Yousician's help pages refuse automated fetches; their "auto-adjust speed, 5% steps" appears only in search snippets and is mentioned without a link. Kenny (2005) on performance-anxiety treatments and Locke & Latham (2002) could not be fetched; Seijts & Latham (2005) is used instead. No source gives an evidence-based tempo step size or spaced-review interval for motor skills; those defaults are design choices.
