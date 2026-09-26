# TDD Testing Standards and Patterns

## Overview

This document defines the testing standards and patterns to be used across all projects. These standards ensure consistency, maintainability, and clear test intent across the codebase.

> **Status: reviewer/agent guidance.** The `defined` gate runs `dotnet
format/build/test`; it does not enforce these test structures, naming rules
> or patterns. Treat this document as the agreed convention for reviews and
> agent work, not a mechanically-checked contract.

### C# Default Testing Stack

- **Framework**: xUnit
- **Mocking**: Moq
- **Assertions**: Shouldly

## Test Class Structure

### Standard Test Class Setup

All test classes must follow this exact format:

```csharp
public class [ClassName]Tests
{
    private const string [ConstantName] = "[constant_value]";
    private const int [AnotherConstant] = [constant_value];

    private readonly Mock<[IDependency1]> _mock[Dependency1] = new();
    private readonly Mock<[IDependency2]> _mock[Dependency2] = new();
    private readonly Mock<[IDependency3]> _mock[Dependency3] = new();

    private readonly [ClassName] _sut;

    public [ClassName]Tests()
    {
        _sut = new [ClassName](_mock[Dependency1].Object, _mock[Dependency2].Object, _mock[Dependency3].Object);
    }

    // Tests go here
}
```

### Setup Rules

- `[ClassName]`: the actual class being tested
- Declare magic strings/values as constants above mocks, in practice there are few due to test parameterisation
- `[IDependency1]`: interface names requiring mocking
- Mock field names: `_mock` + dependency name without the `I` prefix
- Mock declarations always explicitly `private` and `readonly`
- Use `_sut` for "System Under Test"
- `_sut` declaration always `private` and `readonly`.
- `_sut` declaration always above constructor, separated by one line top and bottom.
- Constructor always explicitly `public`
- Dependencies that are mocked are created as class-level `Mock<T>` fields and
  injected via `.Object` in the constructor. Use real implementations where
  mocking would obscure the test (e.g. a hand-rolled fake, a simple value
  object, or a genuine collaborator) — the goal is a clear, honest test, not
  mocking everything by default.

### Example

```csharp
public class TrainingPeaksHistoryServiceTests
{
    private readonly Mock<IUserRepository> _mockUserRepository = new();
    private readonly Mock<IRunHistoryTransformer> _mockTransformer = new();
    private readonly Mock<IValidator<RunEvent>> _mockValidator = new();

    private readonly TrainingPeaksHistoryService _sut;

    public TrainingPeaksHistoryServiceTests()
    {
        _sut = new TrainingPeaksHistoryService(_mockUserRepository.Object, _mockTransformer.Object, _mockValidator.Object);
    }
}
```

## Test Method Patterns

### Test Naming Convention

All tests must follow this naming pattern:

```
[MethodName]_[Condition]_[ExpectedBehaviour]
```

(Existing test methods that already use the American `..._Behavior`/`..._Behaviour`
suffix keep their name for compatibility; new tests use `Behaviour`.)

#### Examples

- `AddRunHistory_WithValidData_ReturnsExpectedRowCount`
- `GetUserData_WithNonExistentUserId_ReturnsNull`
- `Transform_WithEmptyCSV_ReturnsEmptyCollection`

### Test Structure Templates

#### Regular Tests

```csharp
[Fact]
public void [MethodName]_[Condition]_[ExpectedBehaviour]()
{
    // Arrange
    [Setup test data and mocks]

    // Act
    [Call the method being tested]

    // Assert
    [Verify the expected outcome]
}
```

#### Asynchronous Regular Tests

Use `async Task` with `await` when the method under test is asynchronous:

```csharp
[Fact]
public async Task [MethodName]_[Condition]_[ExpectedBehaviour]()
{
    // Arrange
    [Setup test data and mocks]

    // Act
    await [Call the method being tested]

    // Assert
    [Verify the expected outcome]
}
```

#### Parameterised Tests

```csharp
[Theory]
[InlineData(value1)]
[InlineData(value2)]
[InlineData(value3)]
public void [MethodName]_[Condition]_[ExpectedBehaviour]([Type] parameterName)
{
    // Arrange
    [Setup test data using the parameter]

    // Act
    [Call the method being tested]

    // Assert
    [Verify the expected outcome using the parameter]
}
```

#### Exception Testing

```csharp
[Theory]
[InlineData(invalidValue1)]
[InlineData(invalidValue2)]
public void [MethodName]_[InvalidCondition]_[ThrowsSpecificException]([Type] invalidInput)
{
    // Arrange
    [Setup test data with invalid input]

    // Act
    var [descriptiveActionName] = () => _sut.[MethodName](invalidInput);

    // Assert
    Should.Throw<[ExceptionType]>([descriptiveActionName]);
    // or, to assert the message:
    Should.Throw<[ExceptionType]>([descriptiveActionName]).Message.ShouldContain("[expected text]");
}
```

## Core Testing Principles

### Arrange-Act-Assert Pattern

- **Always use Arrange/Act/Assert sections** with comments
- **Arrange**: Set up test data, mocks, and expected values
- **Act**: Call the method being tested
- **Assert**: Verify the expected outcome

### One Behaviour Per Test

- Each test should verify exactly one behaviour
- Don't test multiple things in a single test method
- Use parameterised tests when testing the same logic with different values

### Exception Testing Standards

- Use descriptive variable names in Act section (e.g., `withInvalidUserId`, `withNullData`)
- Follow the pattern: Create lambda → Call `ShouldThrow`/`ShouldThrowAsync` → Verify message
- Always verify the exception message contains expected text

### Async Testing

- Use `async Task` and `await` when the method under test is asynchronous;
  keep tests synchronous when the code under test is synchronous
- Exception testing with async methods requires lambda expressions

### Mock Setup Guidelines

- All mock setups must be in the Arrange section, before Act
- Use `It.IsAny<T>()` when the specific value doesn't matter for the test
- Use specific values when testing the exact parameter passing

## Complete Example

```csharp
[Theory]
[InlineData("")]
[InlineData("   ")]
[InlineData(null)]
public async Task AddRunHistory_WithInvalidEntraId_ThrowsArgumentException(string? invalidEntraId)
{
    // Arrange
    string validCsv = new TrainingPeaksCsvBuilder().Build();

    // Act
    var withInvalidEntraId = async () => await _sut.AddRunHistory(invalidEntraId!, validCsv);

    // Assert
    Exception ex = await withInvalidEntraId.ShouldThrowAsync<ArgumentException>();
    ex.Message.ShouldContain("entraId");
}
```

## Benefits of These Standards

- **Consistency**: All tests follow the same patterns across projects
- **Readability**: Clear structure makes tests easy to understand
- **Maintainability**: Standardised mocking and setup reduces complexity
- **Reliability**: Proper exception testing catches edge cases
- **Parameterisation**: Efficient testing of multiple scenarios
- **TDD Support**: Structure supports test-first development approach
