Build a simple mobile-first web app (HTML, CSS, JavaScript) for a 90-day fitness tracker.

User profile:
- 49-year-old male
- Fat loss goal (88 → 75 kg)
- Daily calorie target: 1750 kcal
- Protein target: 130g
- Workout 5x/week (structured split)

App Requirements:

1. DAILY DASHBOARD
- Show:
  - Planned calories (1750)
  - Planned workout (auto-rotating 7-day schedule) use the body part and suggested exercises associated with it 
  - Planned meals (from predefined weekly plan)

2. USER INPUT
- Weight
- Meals Eaten
- Steps
- Workout done (yes/no)
- Cardio [Duration], Intensity, Calories burnt
- For the Planned bodypart Exercise, weights, Reps 

3. AUTO CALCULATIONS
- Food Calories
- Calories Burnt - Cardios + Exercise
- Caloric Deficit
- Protein adequacy (target 130g)
- Activity score (based on steps + workout)
- Daily adherence score %

4. PROGRESS TRACKING
- Store daily entries 
- Show:
  - Weight trend (chart)
  - Weekly averages
  - Adherence %

5. SMART FEEDBACK
- If calories exceed → show warning
- If protein < target → suggest fix
- If no workout → flag

6. UI REQUIREMENTS
- Mobile-first design
- Simple cards layout
- Minimal typing (use buttons/toggles where possible)
- Simple app that can be access remotely

7. BONUS
- Weekly summary view
- Auto suggestions (reduce calories / increase steps)

Keep it lightweight, fast, and usable on phone browser.

## Proposed Architecture

### App Shape
- Build the app as a mobile-first single-page web app using plain HTML, CSS, and JavaScript.
- Keep the first version frontend-heavy so it stays fast and easy to host remotely on any static hosting service.
- Use a small storage adapter so the prototype can start with `localStorage` and later switch to a cloud datastore without rewriting UI logic.

### Core Modules
1. **Profile and Goal Config**
   - Stores age, current weight, goal weight, calorie target, protein target, and preferred weekly split.

2. **Plan Engine**
   - Rotates the 7-day workout schedule.
   - Maps each workout day to body part, suggested exercises, and the planned meals for that day.

3. **Daily Entry Module**
   - Captures weight, meals eaten, steps, workout completion, cardio details, and exercise set logs.
   - Uses toggles, presets, and small forms to minimize typing on mobile.

4. **Calculation Engine**
   - Totals food calories and protein.
   - Combines workout and cardio burn.
   - Computes caloric deficit, protein adequacy, activity score, and adherence percentage.

5. **Progress and Analytics Module**
   - Stores one entry per day for the full 90 days.
   - Produces weight trend data, weekly averages, completion streaks, and adherence summaries.

6. **Feedback and Suggestions Module**
   - Converts daily metrics into simple guidance such as calorie warnings, protein reminders, missed workout flags, and plateau suggestions.

7. **Sync and Remote Access Layer**
   - Starts with browser storage for speed.
   - Can later move to Firebase or Supabase so the same app works remotely across devices.

### Suggested Data Model
- `profile`
  - age, sex, currentWeight, goalWeight, calorieTarget, proteinTarget
- `weeklyPlan`
  - dayIndex, workoutName, exercises[], meals[]
- `dailyEntry`
  - date, weight, mealsEaten[], steps, workoutDone, cardioMinutes, cardioIntensity, cardioCalories
- `exerciseLog`
  - date, bodyPart, exerciseName, sets[{weight, reps}]
- `dailyMetrics`
  - foodCalories, protein, caloriesBurnt, deficit, activityScore, adherenceScore

### Main UI Surfaces
1. **Daily Dashboard**
   - Shows today's targets, workout, meals, and quick progress cards.

2. **Daily Check-In**
   - Lets the user log meals, steps, cardio, and workout status with minimal typing.

3. **Workout Logger**
   - Shows planned exercises for the day and captures sets, reps, and weights.

4. **Progress View**
   - Shows the 90-day trend, weekly averages, and adherence stats.

5. **Weekly Summary**
   - Recaps performance and suggests the next adjustment.

6. **Smart Feedback Panel**
   - Surfaces alerts and simple next actions based on the day's inputs.
