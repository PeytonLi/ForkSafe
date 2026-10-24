# Evaluation access policy

The public manifest is readable by simulator clients. The withheld manifest is
owned by the evaluator service and is only used by protected evaluation and
finalization code. Candidate registration, simulator requests, controller
artifacts, and public API responses must not reveal withheld scene overrides.
Only frozen finalists are eligible for a withheld evaluation.
