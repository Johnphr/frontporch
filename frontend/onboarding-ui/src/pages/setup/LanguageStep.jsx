// Setup step 3: language first, then a host who speaks it, then a preview of that host's first line.
// Changing the language picks that language's default host. Props as in steps.jsx.
import { HOSTS, hostForLanguage, hostsForLanguage } from '../../copy'
import { SETUP } from '../../copy/setup'
import { HostAvatar } from '../../art/hosts'
import { LanguageArt } from '../../art/setup'
import { ChoiceCard } from '../../ui/controls'
import { QualityChips } from '../../ui/QualityChips'
import { ART, StepCard } from './steps'

const AVATAR = 'h-14 w-14 flex-none sm:h-[4.5rem] sm:w-[4.5rem]'

export function LanguageStep({ data, set, words, onNext, ...frame }) {
  const host = HOSTS[data.host]
  const chooseLanguage = (language) => set({ language, host: hostForLanguage(language) })
  const chooseHost = (id) => set({ host: id })
  return (
    <StepCard {...frame} step={3} art={<LanguageArt className={ART} />} title={words.langTitle} onSubmit={onNext}>
      <fieldset aria-describedby="lang-hint" className="flex w-full min-w-0 flex-col gap-4">
        <legend className="mb-1 font-bold">{SETUP.language.legend}</legend>
        <p id="lang-hint" className="text-sm text-muted">
          {SETUP.language.hint}
        </p>
        <ChoiceCard name="language" value="en" checked={data.language === 'en'} onChange={chooseLanguage} title={SETUP.language.en} sub={SETUP.language.enSub} />
        <ChoiceCard name="language" value="es" checked={data.language === 'es'} onChange={chooseLanguage} title={SETUP.language.es} sub={SETUP.language.esSub} />
      </fieldset>
      <fieldset className="flex w-full min-w-0 flex-col gap-4">
        <legend className="mb-3 font-bold">{SETUP.language.hostLegend}</legend>
        {hostsForLanguage(data.language).map((id) => (
          <ChoiceCard
            key={id}
            name="host"
            value={id}
            checked={data.host === id}
            onChange={chooseHost}
            title={HOSTS[id].name}
            art={<HostAvatar id={id} className={AVATAR} />}
            sub={
              <>
                <span className="my-2 block">
                  <QualityChips qualities={HOSTS[id].qualities} />
                </span>
                {HOSTS[id].blurb}
              </>
            }
          />
        ))}
      </fieldset>
      <div aria-live="polite" className="grid w-full gap-x-6 gap-y-4 rounded-inset bg-wash p-6 min-[544px]:grid-cols-[7rem_minmax(0,1fr)] min-[544px]:items-start">
        <HostAvatar id={data.host} className="h-28 w-28" />
        <div className="flex min-w-0 flex-col items-start gap-4">
          <span className="tag">{words.hostTag}</span>
          <h2 className="text-[2rem]">{host.name}</h2>
          <p className="border-l-4 border-line pl-5 font-display italic leading-snug">{words.hostLine}</p>
          {words.hostTranslation && <p className="text-sm text-muted">{words.hostTranslation}</p>}
        </div>
      </div>
    </StepCard>
  )
}
