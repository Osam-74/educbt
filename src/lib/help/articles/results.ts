import type { HelpArticle } from '../types';

/**
 * Results & Records. Sources verified against the running code:
 *   CA entry     src/app/portal/ca/**, docs/ca-score-entry.md
 *   results      src/app/portal/results/**, src/lib/results/**
 *   report card  src/app/portal/reports/[studentId], docs/report-card-parity.md
 *   remarks/sig  src/app/portal/remarks, signature
 *   promotion    src/app/portal/promotion, transcripts
 *   family       src/app/portal/my-results, children, practice
 */
export const results: HelpArticle[] = [
  {
    slug: 'recording-ca-scores',
    category: 'results',
    title: 'Recording Scores (CA and Exam Marks)',
    description: 'Enter each student\'s continuous-assessment scores on one score sheet.',
    keywords: ['ca', 'continuous assessment', 'record scores', 'score sheet', 'enter scores', 'test scores', 'save scores', 'blank is not zero', 'written exam mark'],
    audience: ['teacher', 'principal', 'vice_principal', 'exam_officer'],
    where: 'Record scores',
    popular: true,
    icon: 'results',
    blocks: [
      { type: 'steps', title: 'Record scores', items: [
        'Open **Record scores**, or select **Open** next to a subject on your dashboard.',
        'Under **Class and subject**, choose the class and subject you teach.',
        'Enter each student\'s score in the box for each assessment component. Every component is on the same sheet.',
        'Select **Save scores**.',
      ] },
      { type: 'list', items: [
        'A score must be between **0 and the component\'s maximum**, with at most two decimal places.',
        '**Leave a box empty** for a student you have not marked yet. Blank is not the same as zero, and blank boxes are not saved.',
        'A **CBT exam mark appears automatically** and cannot be edited here. For a **written** paper the exam mark is entered here like any other component.',
        'You only see the classes and subjects you are assigned to teach. If you see none, the school office assigns them under **Staff**.',
      ] },
      { type: 'warning', text: 'Once a class\'s results have been **reviewed, published or locked**, score entry is closed ("Score entry is closed"). The Principal must reopen the results before a score can be changed.' },
      { type: 'note', text: 'Saving a score resets that result to draft. EduCBT reminds you that results must be compiled again before review.' },
    ],
    related: ['how-results-are-published', 'marking-written-answers'],
  },
  {
    slug: 'how-results-are-published',
    category: 'results',
    title: 'Compiling, Reviewing and Publishing Results',
    description: 'The five result stages, who moves a class from one to the next, and how to correct a published result.',
    keywords: ['results', 'compile', 'recompile', 'review', 'sign off', 'publish', 'lock', 'reopen', 'withdraw publication', 'unlock', 'result stages', 'draft', 'broadsheet', 'correction'],
    audience: ['principal', 'vice_principal', 'exam_officer', 'teacher'],
    where: 'Results',
    popular: true,
    icon: 'results',
    blocks: [
      { type: 'p', text: 'Every class\'s results move through the same stages, in order. Nothing reaches a student or parent until it has been signed off and then published.' },
      { type: 'table', head: ['Stage', 'Meaning'], rows: [
        ['**Draft**', 'Scores have been entered or changed but not compiled yet.'],
        ['**Compiled**', 'Totals, grades and class positions have been worked out.'],
        ['**Reviewed**', 'The Principal has signed off the review.'],
        ['**Published**', 'Visible to students and parents, who are notified.'],
        ['**Locked**', 'The term is closed. Fully read-only, and still visible to families.'],
      ] },
      { type: 'steps', title: 'Take a class from scores to published', items: [
        'Open **Results**. The table lists each class with its **Stage** and number of **Students**.',
        'Select **Compile** (or **Recompile**) on the class. The Principal, Vice Principal and Examination Officer can compile.',
        'Select **Review & Moderate** to check individual students\' marks.',
        'The **Principal** selects **Sign off review**.',
        'The **Principal** selects **Publish to students and parents**.',
        'At the end of term the **Principal** selects **Lock results**.',
      ] },
      { type: 'p', text: 'Open **Broadsheet** from a class row to see every student\'s results for the class side by side.' },
      { type: 'warning', text: 'Only the **Principal** can sign off, publish, lock or reopen results. Every registered subject and assessment component must be complete before sign-off, publication or locking.' },
      { type: 'h', text: 'Correcting a result' },
      { type: 'p', text: 'The Principal opens **Correction**, writes a reason of at least 10 characters, and chooses **Reopen for correction**, **Withdraw publication** or **Unlock results**. Each reversal is audited with the reason.' },
      { type: 'h', text: 'If you cannot compile' },
      { type: 'p', text: 'Compiling needs valid assessment components, a grading scale and a ranking policy. If they are not set up, EduCBT says "Compilation is unavailable until setup is complete". The Principal sets them under **School Settings**.' },
    ],
    related: ['recording-ca-scores', 'report-cards', 'school-settings'],
  },
  {
    slug: 'report-cards',
    category: 'results',
    title: 'Report Cards (Terminal Report Sheet)',
    description: 'Open, print or save a student\'s report sheet as PDF, and set up remarks and signatures.',
    keywords: ['report card', 'report sheet', 'terminal report', 'print', 'pdf', 'download', 'remarks', 'signature', 'class teacher remark', 'principal remark', 'position', 'class average'],
    audience: ['principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent'],
    where: 'Student results / Results',
    popular: true,
    icon: 'results',
    blocks: [
      { type: 'p', text: 'The **Terminal Report Sheet** shows the school crest, name and contact details, the student\'s details (name, admission number, class, session, term, number in class and photo), and a table of **Subject**, **CA**, **Exam**, **Total**, **Grade**, **Pos.**, **Class Avg**, **Highest** and **Remark**. Below are the number of subjects, total score, average and position in class, the grading key, the class teacher\'s and principal\'s remarks, and both signatures.' },
      { type: 'steps', title: 'Print or save as PDF', items: [
        'Open the student\'s report sheet.',
        'Select **Download / Print**.',
        'In the print window, choose **Save as PDF** to keep a file, or print it.',
      ] },
      { type: 'note', text: 'Students and parents can only open a report sheet once the term\'s results are **Published** or **Locked**. Staff can open any term.' },
      { type: 'h', text: 'Class teachers: remarks and signature' },
      { type: 'list', items: [
        '**Remarks** and **Signature** appear in your menu only if you are assigned as a class teacher.',
        'Under **School Settings**, **Signatures & remarks** lets you draw, type or upload a signature, and set remark ranges that supply a default comment for each average-score band.',
        'If you are not a class teacher EduCBT says so, because there is no report sheet for your signature to appear on.',
      ] },
    ],
    related: ['how-results-are-published', 'what-students-see', 'school-settings'],
  },
  {
    slug: 'promotion-and-transcripts',
    category: 'results',
    title: 'Promotion and Transcripts',
    description: 'Move students up at the end of a session and issue official transcripts.',
    keywords: ['promotion', 'promote', 'next class', 'repeat', 'transcript', 'issue transcript', 'reissue', 'serial', 'transfer', 'end of session'],
    audience: ['principal', 'vice_principal', 'exam_officer'],
    where: 'Promotion, Transcripts',
    icon: 'results',
    blocks: [
      { type: 'p', text: 'The Principal, Vice Principal and Examination Officer can prepare promotion. **Only the Principal can commit it.** Transcripts are available to the Principal and Vice Principal.' },
      { type: 'steps', title: 'Issue a transcript', items: [
        'Open **Transcripts** and use **Find a student** to search.',
        'Under **Issue a transcript**, type a **Purpose** (for example transfer) and select **Issue**.',
        'The table records the **Serial**, **Purpose**, **Times issued** and **Last issued**. Select **Reissue** to issue another copy.',
      ] },
      { type: 'note', text: 'Promotion works on a proposal you can review before anything is committed. Select at least one student to continue.' },
    ],
    related: ['how-results-are-published', 'report-cards'],
  },
  {
    slug: 'what-students-see',
    category: 'results',
    title: 'What Students See: Papers, Practice and Results',
    description: 'How a student finds their papers, practises, and checks published results.',
    keywords: ['student', 'my results', 'practice', 'papers', 'start', 'resume', 'take exam', 'student dashboard', 'check results'],
    audience: ['student', 'teacher', 'principal', 'vice_principal', 'exam_officer'],
    where: 'Student dashboard',
    icon: 'results',
    blocks: [
      { type: 'p', text: 'A student\'s dashboard has two cards: **Your papers** and **Check results**.' },
      { type: 'steps', title: 'Sit a paper', items: [
        'Sign in and open the **Dashboard**.',
        'Under **Your papers**, find the paper. It shows the subject, the examination and the duration.',
        'Select **Start**. If you already began, select **Resume**. A submitted paper is marked **Submitted**.',
      ] },
      { type: 'note', text: 'Only subjects the student is registered for appear. If a paper is missing, see *My Examination Does Not Appear*.' },
      { type: 'h', text: 'Practice' },
      { type: 'p', text: 'Open **Practice** to see **Available Practice** papers, ones **In Progress** and **Completed Practice**. Practice never counts towards results. If none are listed, teachers have not added any yet.' },
      { type: 'h', text: 'Results' },
      { type: 'p', text: 'Open **My results** to see **Published results**. If none are shown, no results have been published yet.' },
    ],
    related: ['exam-not-appearing', 'report-cards'],
  },
  {
    slug: 'what-parents-see',
    category: 'results',
    title: 'What Parents See: Children, Results and Timetables',
    description: 'How a parent follows their children and downloads published results.',
    keywords: ['parent', 'guardian', 'my children', 'download results', 'exam timetable', 'invitation', 'accept invitation', 'no children linked'],
    audience: ['parent', 'principal', 'vice_principal', 'exam_officer'],
    where: 'Parent dashboard',
    icon: 'results',
    blocks: [
      { type: 'p', text: 'A parent account opens on **My Children**. Each child\'s card shows their name, admission number and class, with the published terms listed underneath.' },
      { type: 'steps', title: 'Download a child\'s result', items: [
        'Open **My children**.',
        'Find the term under the child\'s name.',
        'Select **Download** to open the report sheet, then use **Download / Print** to save it as PDF.',
      ] },
      { type: 'list', items: [
        'You see a child\'s **Exam timetable** from the menu once the school has released it.',
        'If a term has no results yet you see "No results have been published yet."',
        'If results are not shared with your account you see "Results for this child are not shared with this account. The school office can change this."',
        'If no child appears, you will see "No children are linked to this account yet." Contact the school office.',
      ] },
    ],
    related: ['linking-a-parent', 'report-cards'],
  },
];
