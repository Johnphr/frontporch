// Shapes returned by the public Convex queries in convex/*.ts.

export type Publication = {
  platform: string;
  status: "published" | "draft" | "failed" | "skipped" | "needs_review";
  url?: string;
  draftText?: string;
  error?: string;
};

export type Elder = {
  _id: string;
  name: string;
  expertise: string[];
  language: string;
  bio?: string;
  phoneMasked: string;
};

export type QuestionStatus = "new" | "assigned" | "answered" | "skipped";

export type Question = {
  _id: string;
  _creationTime: number;
  source: string;
  title: string;
  body?: string;
  sourceUrl?: string;
  status: QuestionStatus;
  topics: string[];
  assignedElderName?: string;
  skipReason?: string;
};

export type PublishedAnswer = {
  _id: string;
  _creationTime: number;
  title: string;
  body: string;
  shortVersion: string;
  keyPoints: string[];
  elderFirstName: string;
  questionTitle: string;
  questionUrl?: string;
  publications: Publication[];
  variants?: PostVariants;
  quality?: QualityCheck[];
};

/** Per-platform post texts (disclosure included), from backend post_writer.py. */
export type PostVariants = Partial<
  Record<"bluesky" | "linkedin" | "reddit" | "quora" | "discourse", string>
>;

/** Did this platform's text stick to what the elder actually said? */
export type QualityCheck = {
  platform: string; // feed | bluesky | linkedin | reddit | quora | discourse
  passed: boolean;
  issues: string[];
};

export type AnswerStatus = "draft" | "approved" | "published" | "rejected";

export type Answer = PublishedAnswer & {
  elderName: string;
  transcript: string;
  status: AnswerStatus;
};

export type CallTurn = { role: string; text: string };

export type Call = {
  _id: string;
  _creationTime: number;
  callSid: string;
  status: string;
  elderName: string;
  transcript: CallTurn[];
};

export type Reply = {
  _id: string;
  _creationTime: number;
  platform: string;
  author: string;
  text: string;
  readToElder: boolean;
};
