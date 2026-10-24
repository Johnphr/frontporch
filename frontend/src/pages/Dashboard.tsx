import IntegrationsSection from "./dashboard/IntegrationsSection";
import EldersSection from "./dashboard/EldersSection";
import QuestionsSection from "./dashboard/QuestionsSection";
import CallsSection from "./dashboard/CallsSection";
import AnswersSection from "./dashboard/AnswersSection";

export default function Dashboard() {
  return (
    <main className="page dashboard">
      <h1>Dashboard</h1>
      <p className="muted">
        For organizers: add the people who answer, find questions, watch calls live and publish
        answers.
      </p>
      <IntegrationsSection />
      <EldersSection />
      <QuestionsSection />
      <CallsSection />
      <AnswersSection />
    </main>
  );
}
