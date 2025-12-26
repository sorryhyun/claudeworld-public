## Core Approach

Characters need two things: **외형** (how they look) and **성격** (how they behave). No abstract frameworks—just specific, concrete details that make them feel real.

## 외형 (Appearance)

Write appearance as a bullet list of specific visual traits:

### What to Include
- **Signature feature**: One thing people remember (ribbon, scar, hairstyle, item)
- **Eyes**: Color AND what they reveal (usually calm but sharpens when angry)
- **Body language**: How they carry themselves, default posture
- **Clothing style**: What it says about them
- **Expression shifts**: How their face changes with emotion
- **Gender**: This is needed.

### Examples

**Don't:**
> Brown hair, average height, wears armor

**Do:**
> - **주황빛 단발머리**: 어깨 위까지 오는 밝은 주황색 머리
> - **흰색 리본 머리띠**: 항상 착용하는 트레이드마크
> - **파란 눈동자**: 맑고 투명한 하늘색 눈. 순수해 보이지만 때로 날카롭게 변함
> - **볼륨감 있는 체형**: E컵의 볼륨이 부담스러워 항상 헐렁한 옷을 입는 편

Notice: The eyes aren't just "blue"—they're described with how they CHANGE.

## 성격 (Personality)

Write as a bullet list of **specific behavioral traits**—not abstract concepts.

### What Makes Good Traits

**Abstract (weak):**
- Kind
- Brave
- Has trauma

**Specific (strong):**
- **잔소리 담당**: 프리렌의 게으름, 슈타르크의 겁을 담담히 지적
- **3인칭 화법**: 자신을 "레나는~"이라고 지칭하며 "~까나? 까나?" 어미 사용
- **요리 약점**: 요리를 못해 슈타르크에게 지면 살짝 불만

### Essential Elements

**1. Speech Pattern (말투)**
Every character needs distinctive speech:
- Catchphrases: "카와이이~! 오모치카에리~!", "서두를 필요 없어"
- Sentence endings: ~까나?, ~네, ~이야?
- Tone shifts: When does their voice change?
- Formality level: 존댓말? 반말?

**2. Contradictions Through Behavior**
Don't label the contradiction—SHOW it:

❌ "Has a dark side beneath a cute exterior"
✅ "**밝고 순수함**: 평소에는 해맑고 천진난만한 성격"
✅ "**숨겨진 어둠**: 진지해지면 목소리 톤이 낮아지고 차분해짐"

**3. Relationships with Named People**
Not "cares about friends" but specific dynamics:
- **프리렌 돌봄**: 아침을 깨우고 쓸모없는 마법에 한숨 쉬며 관리
- **슈타르크 관리**: 게으름엔 엄격, 잘하면 살짝 칭찬
- **하이터를 그리움**: 양아버지의 가르침을 소중히 함

**4. Concrete Quirks & Weaknesses**
Small specific things that humanize:
- 꼼꼼하지만 방은 어질러져 있음 (meticulous yet messy room)
- 요리를 못해서 은근히 신경 씀 (can't cook, secretly bothered)
- 귀여운 것 보면 본능적으로 달려듦 (rushes toward cute things)

**5. Trigger Points**
What makes their demeanor shift:
- 마법 이야기에선 눈빛이 살짝 변함
- 광기에 빠지면 눈이 날카롭게 변함
- 옛 동료를 떠올릴 때 표정이 조금 부드러워짐

## Template

### 외형

- **[시그니처]**: [구체적 묘사]
- **[눈동자]**: [색깔] + [감정에 따른 변화]
- **[체형/자세]**: [어떻게 서있는지, 움직이는지]
- **[복장]**: [뭘 입는지, 왜 그런 스타일인지]
- **[표정]**: [기본 표정] + [언제 변하는지]

### 성격

- **[특징적 행동]**: [구체적으로 뭘 하는지]
- **[말투]**: [어떤 어미, 구두점, 특유의 표현을 쓰는지]
- **[관계]**: [특정 인물과의 구체적 상호작용]
- **[약점/집착]**: [작은 결함이나 집착]
- **[이중성]**: [평소 모습] → [특정 상황에서의 변화]

## Anti-Patterns

### The Feature List
❌ "Brown hair, green eyes, medium height, slim build"
✅ One memorable detail + how it reflects character

### The Abstract Trait
❌ "Brave, kind, mysterious"
✅ "First through every door" / "Remembers everyone's name" / "Answers questions with questions"

### The Motivation Statement
❌ "Wants to find her lost brother"
✅ Show this through behavior: "사토시 얘기만 나오면 목소리가 달라짐"

### The Generic Helper
❌ NPC who exists to give quests
✅ NPC with their own concerns who might help IF their interests align

## Quality Check

Before finishing a character:
- [ ] Do they have a specific speech pattern (catchphrase, endings, tone)?
- [ ] Is there at least one concrete quirk or weakness?
- [ ] Are their relationships shown through specific behaviors?
- [ ] Does something about them shift/change in certain situations?
- [ ] Could another writer voice this character consistently?

## Persisting Characters

**Always use `persist_character_design` to save any character you create.** This tool registers the NPC in the game world so they can appear in future scenes.

### Tool Parameters

Call `mcp__subagents__persist_character_design` with:
- **name**: Character's name
- **role**: Their role or occupation
- **appearance**: Physical description (detailed, 3-6 sentences)
- **personality**: Behavioral traits and mannerisms
- **which_location**: Where to place them (`'current'` or location name)
- **secret**: Hidden detail not immediately obvious (optional)
- **cu**: Starting attitude (`friendly`/`neutral`/`wary`/`hostile`)

### Notes
- Include both 외형 and 성격 sections in appearance/personality
- The character only exists in the game after you call this tool
- Never just describe a character without persisting—if they're worth designing, they're worth saving

