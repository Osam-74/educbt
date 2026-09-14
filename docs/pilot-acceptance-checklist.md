# EduCBT Pilot Acceptance & Operational Checklist

**Document Version:** 1.0.0  
**Target Audience:** School Operators, Pilot Managers, Principals, Exam Officers, System Administrators  
**System:** EduCBT Production Platform (Next.js / Neon Postgres)  
**Status:** PILOT OPERATIONAL ACCEPTANCE CHECKLIST  

This checklist provides a sequential, end-to-end operational guide for onboarding a new school or verifying a pilot deployment on EduCBT. Every step represents a gate that must pass before proceeding to the next step.

---

## Operational Workflow Overview

```
 [1. Create School] ----> [2. Create Principal] ---> [3. Session/Term Setup]
                                                             |
 [6. Assign Subjects] <-- [5. Import Students] <--- [4. Import Staff]
        |
        v
 [7. Load Questions] ---> [8. Configure Exam] ----> [9. Timetable Setup]
                                                             |
 [12. Mark Theory] <----- [11. Sit Exam] <--------- [10. Assign Invigilators]
        |
        v
 [13. Enter CA Marks] --> [14. Compile Results] --> [15. Review & Publish]
                                                             |
 [18. Promote Class] <--- [17. Print Reports] <---- [16. Parent Access]
```

---

## 1. School Creation

* **Operator Role:** Platform Admin (`platform_admin`)
* **UI Path & Action:**
  1. Log in at `/sign-in` as Platform Admin.
  2. Navigate to Platform Console at `/platform/schools`.
  3. Click **"New School"** button (navigates to `/platform/schools/new`).
  4. Enter School Details:
     * **School Name:** `Greensprings Academy`
     * **School Code:** `GSA`
     * **Subdomain:** `greensprings`
     * **Custom Domain (Optional):** `portal.greensprings.edu.ng`
     * **Principal Name:** `Dr. Mrs. A. Adebayo`
     * **Address & Contact Info:** Enter official address, phone, and email.
     * **School Logo:** Upload logo image.
  5. Click **"Create School"** submit button.
* **Success Verification:**
  * System displays success alert banner: *"School created successfully."*
  * Redirects to `/platform/schools`. `Greensprings Academy` appears in the list with `active` badge status.
  * Subdomain route `greensprings.educbt.com` or custom domain resolves to the tenant login page.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Subdomain or School Code already in use."* -> Unique constraint collision in `schools` table. Use a unique subdomain/code.
  * **Symptom:** Subdomain link gives 404 page -> CNAME / wildcard DNS routing not configured on Vercel.

---

## 2. Principal Account Creation

* **Operator Role:** Platform Admin (`platform_admin`)
* **UI Path & Action:**
  1. On `/platform/schools`, click on `Greensprings Academy` to open school details (`/platform/schools/[id]`).
  2. Click **"Create Principal Account"** button.
  3. Form Inputs:
     * **Login ID / Email:** `principal@greensprings.edu.ng`
     * **Full Name:** `Dr. Mrs. A. Adebayo`
     * **Temporary Password:** Enter secure initial password.
  4. Click **"Save Account"**.
* **Success Verification:**
  * Success toast appears: *"Principal account created."*
  * User row appears under School Users with `role = principal` and status `active`.
  * Database `users` table record reflects `must_change_password = true`.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"User with this email already exists."* -> Login ID conflict. Choose a unique email/login ID.
  * **Symptom:** Created user cannot log in -> Ensure `school_id` is assigned and user status is not `suspended`.

---

## 3. Academic Session & Term Configuration

* **Operator Role:** Principal (`principal`)
* **UI Path & Action:**
  1. Log in at `/sign-in` with Principal credentials. Forced password change prompt appears on first login -> update password.
  2. Navigate to **School Settings** via left sidebar: `/portal/settings`.
  3. Under **Academic Calendar**, click **"Add Academic Session"**:
     * **Title:** `2025/2026`
     * **Starts On / Ends On:** Select session date range.
     * Check **"Set as Current Session"**.
  4. Click **"Add Term"**:
     * **Title:** `First Term`
     * **Position:** `1`
     * Check **"Set as Current Term"**.
  5. Under **Grading Configuration**, select grading scale version, configure grade bands (A: 75-100, B: 65-74, C: 50-64, D: 45-49, E: 40-44, F: 0-39) and automatic remark ranges.
  6. Under **Signatures**, upload Principal digital signature image.
  7. Click **"Save Settings"**.
* **Success Verification:**
  * Top navigation header displays active session badge: **"2025/2026 - First Term"**.
  * Settings page shows `is_current = true` indicator next to `2025/2026` and `First Term`.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"A current session is already active."* -> Uncheck current flag on previous session before setting a new one.
  * **Symptom:** Grade boundaries overlap (e.g. B: 60-75 and A: 70-100) -> Validation error *"Grade bands cannot overlap."* Adjust ranges.

---

## 4. Staff Import & Account Creation

* **Operator Role:** Principal or Vice Principal
* **UI Path & Action:**
  1. Navigate to **Staff Office** at `/portal/staff`.
  2. Option A (Single Entry): Click **"Add Staff"**, fill staff number, full name, email, phone, designation, and select role (`teacher`, `exam_officer`, `vice_principal`).
  3. Option B (Bulk Import): Click **"Upload Staff CSV"**, select CSV file containing columns: `staff_number,first_name,last_name,email,role,designation`.
  4. Click **"Import Staff"**.
* **Success Verification:**
  * Success notification displays imported row count (e.g. *"25 staff members imported successfully."*).
  * Staff list table displays staff members with valid IDs, assigned roles, and `active` status badges.
  * Corresponding records created in both `staff` and `users` tables.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Invalid role specified in CSV."* -> Role must be one of: `principal`, `vice_principal`, `exam_officer`, `teacher`.
  * **Error:** *"Duplicate staff number or email."* -> Clean duplicate rows in CSV before re-uploading.

---

## 5. Students Import & Account Creation

* **Operator Role:** Principal / Vice Principal / School Admin
* **UI Path & Action:**
  1. Navigate to **Student Office** at `/portal/students`.
  2. Click **"Upload Student CSV"** button.
  3. Select CSV file with schema: `admission_number,first_name,last_name,gender,dob,class_level,department,arm`. Example row: `2025/001,John,Doe,male,2012-05-14,SS1,Science,A`.
  4. Map CSV columns to database fields if prompted and click **"Process Import"**.
* **Success Verification:**
  * Summary page shows: *"450 Students created and enrolled for 2025/2026 First Term."*
  * Student directory displays students with admission numbers, assigned class arms (`SS1 Science A`), and `active` status.
  * Check student detail page (`/portal/students/[id]`) to confirm active enrollment record in `enrollments` table.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Admission number 2025/001 already exists in this school."* -> Admission numbers must be unique within the tenant.
  * **Symptom:** Students imported without active enrollment -> Class level or arm string in CSV did not match configured class levels.

---

## 6. Academic Structure, Subjects & Teacher Assignments

* **Operator Role:** Vice Principal / Exam Officer
* **UI Path & Action:**
  1. Navigate to **Classes & Levels** at `/portal/classes`:
     * Create Level: `SS1` (Stage: `senior`).
     * Create Department: `Science`.
     * Create Class Arm: `SS1 Science A`.
  2. Navigate to **Subjects** at `/portal/subjects`:
     * Click **"Add Subject"**: Name: `Mathematics`, Code: `MTH`, Stage: `senior`, Category: `core`.
     * Repeat for other subjects (e.g. `English Language`, `Physics`, `Chemistry`).
  3. Assign Subjects to Classes: Link `MTH` to `SS1 Science A`.
  4. Assign Teachers (`staff_assignments`): Assign `Mr. Alex Johnson` as subject teacher for `Mathematics` in `SS1 Science A`.
* **Success Verification:**
  * Subject directory shows active subjects with codes and assigned class offerings.
  * Teacher portal dashboard (`/portal`) displays assigned class subjects under "My Classes".
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Subject code MTH already exists."* -> Subject codes must be unique per school. Use distinct codes for Junior (`MTH-J`) vs Senior (`MTH`).
  * **Symptom:** Teacher opens CA score entry but sees no classes -> `staff_assignments` missing for that teacher.

---

## 7. Question Bank Loading

* **Operator Role:** Subject Teacher (`teacher`) or Exam Officer (`exam_officer`)
* **UI Path & Action:**
  1. Log in as Subject Teacher and navigate to **Question Bank** at `/portal/questions`.
  2. Click **"New Question Set"**:
     * **Title:** `SS1 Mathematics First Term Question Pool`
     * **Subject:** `Mathematics (MTH)`
     * **Level/Department:** `SS1 / Science`
  3. Click **"Add Question"**:
     * **Type:** Select `MCQ` or `Theory`.
     * **Passage (Optional):** Attach comprehension passage if applicable.
     * **Stem:** Enter question text (e.g., *"Solve for x: 2x + 5 = 15"*). Supports LaTeX math formulas.
     * **Marks:** Set mark weight (e.g. `2.00`).
     * **Options (MCQ):** Enter 4 option choices (A, B, C, D) and mark radio button for correct option.
  4. Repeat for all pool questions (e.g. 40 questions).
  5. Click **"Publish Question Set"**.
* **Success Verification:**
  * Question set status badge updates to `published`.
  * Question count counter displays `40 questions`.
  * Questions verified in `/portal/questions/[setId]` preview.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Cannot publish: Question 12 has no correct option selected."* -> Every MCQ must have exactly 1 correct option marked.
  * **Symptom:** Math equations display as raw text -> Ensure LaTeX syntax is wrapped in `\( ... \)` delimiters.

---

## 8. Exam Series & Paper Configuration

* **Operator Role:** Exam Officer (`exam_officer`)
* **UI Path & Action:**
  1. Navigate to **Exams Office** at `/portal/exams`.
  2. Click **"New Exam Series"**: Title: `2025/2026 First Term Main CBT`.
  3. Open series details (`/portal/exams/[seriesId]`) and click **"Add Exam Paper"**:
     * **Subject:** `Mathematics`
     * **Class Level / Dept:** `SS1 / Science`
     * **Target Class:** `SS1 Science A`
     * **Linked Question Set:** Select `SS1 Mathematics First Term Question Pool`.
     * **Duration:** `60 minutes`.
     * **Question Count:** `30` (pulls 30 random items from 40-question pool).
     * **Settings:** Enable **Shuffle Questions** and **Shuffle Options**.
  4. Click **"Publish Paper"**.
* **Success Verification:**
  * Exam Paper created with status `published`.
  * Paper listed under Series details with `30 questions`, `60 mins` duration.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Question count (50) exceeds available questions in set (40)."* -> Pool must have at least as many questions as paper `question_count`.
  * **Symptom:** Students see draft status -> Paper status was left as `draft`; must click **"Publish Paper"**.

---

## 9. Timetable Preparation & Schedule Verification

* **Operator Role:** Exam Officer (`exam_officer`)
* **UI Path & Action:**
  1. Navigate to **Exam Timetable** at `/portal/timetable`.
  2. Select Exam Paper: `SS1 Mathematics Paper`.
  3. Set Schedule:
     * **Scheduled Date & Time:** `2026-10-15 09:00 AM`
     * **Venue:** `Computer Lab 1`
     * **Duration:** Auto-filled `60 mins`.
     * **Closes At:** Auto-calculated `2026-10-15 10:00 AM`.
  4. Click **"Save Schedule"**.
* **Success Verification:**
  * Timetable grid displays scheduled paper without clash warnings.
  * `closes_at` timestamp is populated in `exam_papers` table (`scheduled_at + duration_seconds`).
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Venue Clash: Computer Lab 1 is already booked for SS1 Physics at 09:00 AM."* -> Adjust venue or scheduled time slot.
  * **Error:** *"Class Schedule Clash: SS1 Science A has another paper scheduled at this time."* -> Re-schedule one paper.

---

## 10. Invigilator Assignment & Access Code Release

* **Operator Role:** Exam Officer (`exam_officer`)
* **UI Path & Action:**
  1. Navigate to **Invigilation Office** at `/portal/invigilation`.
  2. Select Paper: `SS1 Mathematics Paper`.
  3. Click **"Assign Invigilator"**: Select `Mr. David Adeleke` (`teacher`).
  4. Toggle **"Require Access Code"** to `ON`.
  5. Click **"Generate Access Code"**. A 16-character alphanumeric code (e.g. `MATH-2026-X8K9`) is generated.
  6. Click **"Release Code to Invigilator"**.
* **Success Verification:**
  * Invigilator dashboard at `/portal/invigilate/[paperId]` displays active exam session, live candidate roster, and released Access Code.
  * Database records `access_code` and `code_released_at` timestamp.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Access code not released."* -> Students will be blocked at start screen. Invigilator must click **"Release Code"**.

---

## 11. Student Examination Sitting (CBT Engine)

* **Operator Role:** Student (`student`)
* **UI Path & Action:**
  1. Student goes to `/sign-in`, enters Admission Number (`2025/001`) and password.
  2. Student portal home lists available exam: `SS1 Mathematics Paper`.
  3. Student clicks **"Start Exam"** (navigates to `/exam/[paperId]`).
  4. Access Code prompt appears -> Student enters Access Code `MATH-2026-X8K9` announced by invigilator.
  5. Student answers MCQ questions, bookmarks questions to review, and navigates back/forth. Timer counts down server-synced time.
  6. Click **"Submit Examination"** (or allow timer to reach 0:00 for auto-submit).
* **Success Verification:**
  * Submission confirmation screen appears: *"Exam submitted successfully."*
  * Candidate status on Invigilator Monitor (`/portal/invigilate/[paperId]`) changes from `in_progress` to `submitted`.
  * Attempt record in `attempts` table records `submitted_at`, `status = submitted`, and auto-calculated MCQ `score`.
* **Failure Symptoms & Troubleshooting:**
  * **Symptom:** Network disconnect during exam -> Candidate browser retains offline state. On reconnect, client retries save using `idempotency_key` without duplicate answer rows.
  * **Symptom:** Candidate alt-tabs -> Invigilator dashboard logs `window_blur` integrity event in `attempt_events`.

---

## 12. Theory Question Marking

* **Operator Role:** Subject Teacher (`teacher`) / Examiner
* **UI Path & Action:**
  1. Subject Teacher logs in and navigates to **Marking Office** at `/portal/marking`.
  2. Select Paper: `SS1 Mathematics Paper`.
  3. System displays pending candidate submissions containing essay/theory responses.
  4. For each student response:
     * Review student text response.
     * Enter **Awarded Marks** (e.g. `4.5` out of `5.00`).
     * Enter optional feedback remark.
  5. Click **"Save & Finalize Marks"**.
* **Success Verification:**
  * Marking progress bar reaches `100% Complete`.
  * Attempt `score` in `attempts` table updates to reflect `MCQ Score + Awarded Theory Score`.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Awarded marks (6.0) exceed maximum question marks (5.0)."* -> System enforces `awarded_marks <= max_marks`. Correct mark input.

---

## 13. Continuous Assessment (CA) Score Entry

* **Operator Role:** Subject Teacher (`teacher`)
* **UI Path & Action:**
  1. Navigate to **CA Score Office** at `/portal/ca`.
  2. Select Class: `SS1 Science A`, Subject: `Mathematics`.
  3. Score grid displays enrolled students. Enter CA component marks:
     * **CA 1 (10%):** Enter marks (e.g. `8`).
     * **CA 2 (10%):** Enter marks (e.g. `9`).
     * **Assignment / Project (10%):** Enter marks (e.g. `7`).
  4. Click **"Save CA Scores"**.
  5. Click **"Submit CA Scores to Exam Officer"**.
* **Success Verification:**
  * CA score table displays status `submitted`.
  * Scores locked against further editing by teacher unless reopened by Exam Officer.
  * Records saved in `assessment_scores` table with valid `school_id`, `student_id`, `subject_id`.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"CA score (12) exceeds component maximum (10)."* -> Validate score entry range.
  * **Symptom:** Teacher unable to edit -> Status is `submitted`; Exam Officer must unlock scores.

---

## 14. Result Compilation

* **Operator Role:** Exam Officer (`exam_officer`)
* **UI Path & Action:**
  1. Navigate to **Results Office** at `/portal/results`.
  2. Select Target: Session `2025/2026`, Term `First Term`, Class `SS1 Science A`.
  3. Click **"Compile Results"** button.
  4. System executes compilation background process:
     * Combines CA Scores + Exam Scores -> `Total Score (100%)`.
     * Resolves Grade Bands (e.g., `84.00` -> Grade `A`, Remark `EXCELLENT`).
     * Computes Subject Positions (`1st`, `2nd`, `3rd`), Class Averages, Minimum and Maximum scores.
* **Success Verification:**
  * Compilation banner displays: *"Results compiled successfully for 35 students."*
  * Status badge for `SS1 Science A` updates to `compiled`.
  * `subject_results` table populated with verified totals, grades, and positions.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Cannot compile: Missing CA scores for 3 students in Chemistry."* -> All subject assessment scores must be submitted prior to compilation.
  * **Symptom:** Position tie -> System assigns joint position (e.g. two students tied at `1st`).

---

## 15. Result Review & Publication

* **Operator Role:** Vice Principal (Review) & Principal (Publish)
* **UI Path & Action:**
  1. **VP Academics Review:** Log in as VP, navigate to **Broadsheet** at `/portal/broadsheet`. Review class summary performance, subject distributions, and pass rates. Click **"Approve & Forward to Principal"**.
  2. **Principal Sign-Off & Publish:** Log in as Principal, navigate to `/portal/results` or `/portal/review`:
     * Select `SS1 Science A`.
     * Review compiled broadsheet and automated principal remarks.
     * Enter custom Principal Comments if required.
     * Click **"Publish Results"** button.
* **Success Verification:**
  * Result status badge updates from `compiled` -> `published`.
  * Results become immediately visible on Parent and Student portals.
  * Audit log records publication event with Principal user ID and timestamp.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Only Principal can publish results."* -> Role check enforced (`userRole = principal`). Non-principals get authorization denial.
  * **Symptom:** Results published with wrong remark ranges -> Update remark ranges in `/portal/settings` before re-compiling.

---

## 16. Parent Portal Access & Verification

* **Operator Role:** Parent / Guardian (`parent`)
* **UI Path & Action:**
  1. Parent logs in at `/sign-in` using registered email.
  2. Navigate to **My Children** at `/portal/children`.
  3. Click **"Link Child"**: Enter Student Admission Number (`2025/001`) and Parent Verification Pin.
  4. Once linked, select child `John Doe` and click **"View Report Card"** for `2025/2026 First Term`.
* **Success Verification:**
  * Parent views child's published term report sheet showing subject marks, grades, position, teacher remarks, and attendance.
  * Parent is strictly denied access to any staff office pages or other students' reports (RLS policy check).
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Results for this term are not yet published."* -> Principal has not clicked "Publish Results".
  * **Error:** *"Access Denied"* when parent accesses staff route -> Authorization system working as expected.

---

## 17. Report Card Printing & Fidelity Check

* **Operator Role:** Principal / Class Teacher
* **UI Path & Action:**
  1. Navigate to **Reports** at `/portal/reports/[studentId]`.
  2. Select Student `John Doe`, Session `2025/2026`, Term `First Term`.
  3. Review rendered Terminal Report Card sheet on screen.
  4. Click **"Print Report Sheet"** button on toolbar (`PrintToolbar.tsx`).
  5. Browser print dialog opens -> Select "Save as PDF" or physical printer.
* **Success Verification:**
  * Layout renders cleanly on a **single page** (for standard 9-12 subject load) without text spillover or second-page orphan rows.
  * Report includes: School logo, student photo, subject table, CA/Exam breakdown, grade key, class teacher remark, principal signature image, and HMAC-signed QR code.
  * Scanning the QR code points to `/verify/transcript` confirming document authenticity.
* **Failure Symptoms & Troubleshooting:**
  * **Symptom:** Report card spills onto 2 pages -> CSS class name regression. Ensure print styles use namespaced classes (`.doc__tr-*`) and do not override generic `.doc__*` styles parity-locked to report sheet.

---

## 18. Student Class Promotion & Academic Rollover

* **Operator Role:** Vice Principal / Principal
* **UI Path & Action:**
  1. Navigate to **Promotion Office** at `/portal/promotion`.
  2. Click **"New Promotion Batch"**:
     * **From Session:** `2025/2026` -> **To Session:** `2026/2027`
     * **Source Class:** `SS1 Science A` -> **Target Class:** `SS2 Science A`
  3. System evaluates cumulative annual performance against promotion criteria (e.g. Average >= 50% = Promoted).
  4. Review student decision list (`promoted`, `repeat`, `withdrawn`). Override individual decisions if required.
  5. Click **"Propose Promotion Batch"** (VP Academics).
  6. Principal reviews proposed batch and clicks **"Commit Promotion Batch"**.
* **Success Verification:**
  * Batch status updates to `committed`.
  * Student enrollment records updated: Students moved to `SS2 Science A` in session `2026/2027`.
  * Historical enrollment for `2025/2026 SS1 Science A` preserved in `enrollments` table for transcript compilation.
* **Failure Symptoms & Troubleshooting:**
  * **Error:** *"Batch already committed."* -> Promotion decisions are final once committed. To alter, use **"Reverse Promotion Batch"** before creating a new batch.

---

## Acceptance Sign-Off Matrix

| Step # | Gate / Capability | Assigned Operator | Status | Sign-off Date |
| :--- | :--- | :--- | :--- | :--- |
| **1** | School Creation | Platform Admin | [ ] PASS | ___________ |
| **2** | Principal Creation | Platform Admin | [ ] PASS | ___________ |
| **3** | Session/Term Config | Principal | [ ] PASS | ___________ |
| **4** | Staff Import | Principal / VP | [ ] PASS | ___________ |
| **5** | Student Import | Principal / Admin | [ ] PASS | ___________ |
| **6** | Subject/Class Allocation | VP / Exam Officer | [ ] PASS | ___________ |
| **7** | Question Bank Loaded | Teacher / Exam Officer | [ ] PASS | ___________ |
| **8** | Exam Paper Configured | Exam Officer | [ ] PASS | ___________ |
| **9** | Timetable Prepared | Exam Officer | [ ] PASS | ___________ |
| **10** | Invigilators Assigned | Exam Officer | [ ] PASS | ___________ |
| **11** | Exam Sitting (CBT) | Candidate / Student | [ ] PASS | ___________ |
| **12** | Theory Marking | Teacher / Examiner | [ ] PASS | ___________ |
| **13** | CA Marks Entry | Subject Teacher | [ ] PASS | ___________ |
| **14** | Result Compilation | Exam Officer | [ ] PASS | ___________ |
| **15** | Result Review & Publish | Principal / VP | [ ] PASS | ___________ |
| **16** | Parent Portal Access | Parent / Guardian | [ ] PASS | ___________ |
| **17** | Report Card Printing | Class Teacher | [ ] PASS | ___________ |
| **18** | Class Promotion | Principal / VP | [ ] PASS | ___________ |

*End of Pilot Acceptance Checklist.*
