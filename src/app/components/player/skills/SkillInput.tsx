import { PlayerSkills } from '@/types/Player';
import Image, { StaticImageData } from 'next/image';
import React, { useId } from 'react';
import { observer } from 'mobx-react-lite';
import NumberInput from '@/app/components/generic/NumberInput';

export interface SkillChange {
  skills?: Partial<PlayerSkills>;
  boosts?: Partial<PlayerSkills>;
}

interface SkillInputProps {
  name: string;
  field: keyof PlayerSkills;
  image: string | StaticImageData;
  skills: PlayerSkills;
  boosts: PlayerSkills;
  onChange: (change: SkillChange) => void;
}

const SkillInput: React.FC<SkillInputProps> = observer((props) => {
  const {
    name, field, image, skills, boosts, onChange,
  } = props;
  const id = useId();

  return (
    <>
      <div className="text-sm flex justify-center">
        <Image src={image} alt={name} />
      </div>
      <div className="flex items-center w-32">
        <div className="text-sm font-mono w-14 text-right">
          {field === 'hp' ? (
            <div className="flex items-center">
              <NumberInput
                className="form-control w-full"
                id={id}
                required
                min={1}
                max={255}
                title={`Your current ${name} level`}
                value={skills[field] + boosts[field]}
                onChange={(v) => {
                  onChange({
                    boosts: {
                      [field]: v - skills[field],
                    },
                  });
                }}
              />
              /
            </div>
          ) : (
            <span title={`Your current ${name} level`}>
              {skills[field] + boosts[field]}
              /
            </span>
          )}
        </div>
        <div className="w-12">
          <NumberInput
            className="form-control w-full"
            id={id}
            required
            min={1}
            max={255}
            title={`Your base ${name} level`}
            value={skills[field]}
            onChange={(v) => {
              onChange({
                skills: {
                  [field]: v,
                },
              });
            }}
          />
        </div>
      </div>
    </>
  );
});

export default SkillInput;
